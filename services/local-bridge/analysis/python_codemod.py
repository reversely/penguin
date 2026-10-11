"""Penguin's codemod for mechanical interface changes (`fix:python-codemod`, PRD section 5.3 step 3).

Usage: python3 -I python_codemod.py --tree WORKTREE < request.json

The request is a JSON object on standard input:

    {"edits": [{"kind": "rename", "from": "shared.dates.start_of_day",
                "to": "shared.dates.start_of_local_day"}, ...],
     "paths": ["analytics/weekly.py", ...]}

Each edit comes from the contract diff of `analysis:python-impact`:

- ``rename`` and ``move`` rewrite every import and reference of the dotted name ``from`` to ``to``,
  with libcst's ``RenameCommand`` (libcst 1.9.0, PRD T21).
- ``rename-parameter`` rewrites the keyword ``from`` to ``to`` in each call that resolves to the
  dotted ``function``.

The script rewrites only the listed files, in place, inside WORKTREE: a throwaway worktree the bridge
made. A path that is absolute, not normalised, outside the tree, a symlink, under a symlinked
directory or not a ``.py`` file is refused and never opened. The code is parsed, never imported or
run. The report on standard output lists each file changed, each file left alone and each refusal.

Exit status 2 means the request was malformed; nothing was written.
"""

import argparse
import json
import os
import re
import stat
import sys
from pathlib import PurePosixPath

import libcst as cst
import libcst.matchers as m
from libcst.codemod import CodemodContext
from libcst.codemod.commands.rename import RenameCommand
from libcst.metadata import MetadataWrapper, QualifiedNameProvider

SCHEMA_VERSION = 1
MAX_EDITS = 50
MAX_PATHS = 2_000
MAX_FILE_BYTES = 1_000_000
DOTTED = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127})*$"
)
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
KINDS = {
    "rename": {"from", "to"},
    "move": {"from", "to"},
    "rename-parameter": {"function", "from", "to"},
}


class RequestError(Exception):
    """The request is malformed."""


def check_edit(edit: object) -> dict:
    """Return the edit when it is well formed; raise RequestError otherwise."""
    if not isinstance(edit, dict) or edit.get("kind") not in KINDS:
        raise RequestError(
            f"an edit must be an object whose kind is one of {sorted(KINDS)}"
        )
    fields = KINDS[edit["kind"]]
    if set(edit) != fields | {"kind"}:
        raise RequestError(
            f"a {edit['kind']} edit has exactly the fields kind, {', '.join(sorted(fields))}"
        )
    for key in fields:
        value = edit[key]
        pattern = (
            IDENTIFIER
            if edit["kind"] == "rename-parameter" and key != "function"
            else DOTTED
        )
        if not isinstance(value, str) or len(value) > 512 or not pattern.match(value):
            raise RequestError(f"{key} of a {edit['kind']} edit is not a Python name")
    if edit["from"] == edit["to"]:
        raise RequestError("from and to must differ")
    return edit


def read_request(text: str) -> tuple[list[dict], list[str]]:
    """Parse and check the request; raise RequestError when it is malformed."""
    try:
        request = json.loads(text)
    except json.JSONDecodeError as error:
        raise RequestError(f"the request is not JSON: {error}") from None
    if not isinstance(request, dict) or set(request) != {"edits", "paths"}:
        raise RequestError("the request is an object with exactly edits and paths")
    edits, paths = request["edits"], request["paths"]
    if not isinstance(edits, list) or not 0 < len(edits) <= MAX_EDITS:
        raise RequestError(f"edits must list 1 to {MAX_EDITS} edits")
    if (
        not isinstance(paths, list)
        or len(paths) > MAX_PATHS
        or not all(isinstance(p, str) for p in paths)
    ):
        raise RequestError(f"paths must list at most {MAX_PATHS} strings")
    return [check_edit(edit) for edit in edits], list(dict.fromkeys(paths))


def refusal(tree: str, path: str) -> str | None:
    """Why ``path`` may not be rewritten inside ``tree``, or None when it may."""
    if len(path) > 1024 or "\0" in path or "\\" in path:
        return "not a repository path"
    pure = PurePosixPath(path)
    if (
        pure.is_absolute()
        or str(pure) != path
        or any(part in ("", ".", "..") for part in path.split("/"))
    ):
        return "not a normalised relative path"
    if pure.suffix != ".py":
        return "not a Python file"
    # Every directory on the way and the file itself must be real, so nothing leaves the checkout.
    current = tree
    for part in path.split("/"):
        current = os.path.join(current, part)
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            return "missing"
        if stat.S_ISLNK(mode):
            return "a symlink"
    if not stat.S_ISREG(os.lstat(current).st_mode):
        return "not a regular file"
    real_tree = os.path.realpath(tree)
    if os.path.commonpath([real_tree, os.path.realpath(current)]) != real_tree:
        return "outside the checkout"
    if os.path.getsize(current) > MAX_FILE_BYTES:
        return "too large"
    return None


def module_name(path: str) -> str:
    """The dotted module a repository path defines, such as ``analytics.weekly``."""
    parts = list(PurePosixPath(path).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


class RenameKeyword(m.MatcherDecoratableTransformer):
    """Rewrites keyword ``old`` to ``new`` in each call that resolves to ``function``."""

    METADATA_DEPENDENCIES = (QualifiedNameProvider,)

    def __init__(self, function: str, old: str, new: str) -> None:
        super().__init__()
        self.function = function
        self.old = old
        self.new = new

    def leave_Call(self, original_node: cst.Call, updated_node: cst.Call) -> cst.Call:
        names = {
            name.name
            for name in self.get_metadata(
                QualifiedNameProvider, original_node.func, set()
            )
        }
        if self.function not in names:
            return updated_node
        args = [
            arg.with_changes(keyword=cst.Name(self.new))
            if arg.keyword is not None and arg.keyword.value == self.old
            else arg
            for arg in updated_node.args
        ]
        return updated_node.with_changes(args=args)


def apply_edits(source: str, path: str, edits: list[dict]) -> tuple[str, list[int]]:
    """The rewritten source and the indexes of the edits that changed it."""
    module = cst.parse_module(source)
    applied = []
    for index, edit in enumerate(edits):
        before = module.code
        if edit["kind"] == "rename-parameter":
            module = MetadataWrapper(module).visit(
                RenameKeyword(edit["function"], edit["from"], edit["to"])
            )
        else:
            context = CodemodContext(filename=path, full_module_name=module_name(path))
            module = RenameCommand(context, edit["from"], edit["to"]).transform_module(
                module
            )
        if module.code != before:
            applied.append(index)
    return module.code, applied


def run(tree: str, edits: list[dict], paths: list[str]) -> dict:
    changed, unchanged, errors = [], [], []
    for path in paths:
        reason = refusal(tree, path)
        if reason is not None:
            errors.append({"path": path, "kind": "refused", "message": reason})
            continue
        file = os.path.join(tree, path)
        try:
            with open(file, encoding="utf-8", newline="") as handle:
                source = handle.read()
        except UnicodeDecodeError:
            errors.append(
                {"path": path, "kind": "not-utf8", "message": "the file is not UTF-8"}
            )
            continue
        try:
            rewritten, applied = apply_edits(source, path, edits)
        except cst.ParserSyntaxError as error:
            errors.append(
                {"path": path, "kind": "syntax", "message": str(error).splitlines()[0]}
            )
            continue
        if rewritten == source:
            unchanged.append(path)
            continue
        with open(file, "w", encoding="utf-8", newline="") as handle:
            handle.write(rewritten)
        changed.append({"path": path, "edits": applied})
    return {
        "schemaVersion": SCHEMA_VERSION,
        "commandId": "fix:python-codemod",
        "edits": edits,
        "changed": changed,
        "unchanged": unchanged,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Penguin's codemod for mechanical interface changes"
    )
    parser.add_argument("--tree", required=True)
    args = parser.parse_args()
    try:
        edits, paths = read_request(sys.stdin.read())
    except RequestError as error:
        print(f"python_codemod: {error}", file=sys.stderr)
        return 2
    if not os.path.isdir(args.tree):
        print("python_codemod: --tree is not a directory", file=sys.stderr)
        return 2
    json.dump(run(args.tree, edits, paths), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
