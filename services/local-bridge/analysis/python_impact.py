"""Impact graph and contract diff for Python, read from Git trees with the standard library only.

Usage: python3 -I python_impact.py --repo PATH < request.json

The request is a JSON object: ``{"base": SHA, "head": SHA, "forks": [{"id": ID, "sha": SHA,
"scopes": [SCOPE ID, ...], "since": SHA}]}``. The report on standard output names every function,
method, class and module-level value the change from ``base`` to ``head`` touches, the changed
signatures, the removed exports, the changed stored data shapes, and each place in each fork's
scopes that imports, calls or references a changed symbol, with its file and line.

A fork with ``since`` (main's commit) reports only the uses in files the fork added or changed since
its merge base with ``since``. A use in a file the fork carries unchanged from main is main's caller,
which the fork takes with main; the report counts those as ``carried``.

Source is never imported or executed. Paths come from ``git ls-tree``, file bytes from ``git
cat-file``, and each file is parsed with ``ast.parse``. A file that cannot be read safely becomes a
structured error in the report.
"""

import argparse
import ast
import json
import keyword
import os
import posixpath
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field

TOOL = "python-impact"
COMMAND_ID = "analysis:python-impact"
SCHEMA_VERSION = 1
SCOPES_FILE = "penguin/scopes.json"

SHA = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
FORK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MAX_REQUEST_BYTES = 1_000_000
MAX_FORKS = 256

# Kinds of change that leave existing callers pointing at different behaviour or at nothing.
CALLER_CHANGES = frozenset({"modified", "removed", "renamed", "moved"})
POSITIONAL = frozenset({"positional-only", "positional"})
VARIADIC = frozenset({"var-positional", "var-keyword"})

# Standard library markers of a class whose instances are stored or serialised field by field.
RECORD_DECORATORS = frozenset({"dataclass"})
RECORD_BASES = {
    "NamedTuple": "namedtuple",
    "TypedDict": "typeddict",
    "Enum": "enum",
    "IntEnum": "enum",
    "StrEnum": "enum",
    "Flag": "enum",
    "IntFlag": "enum",
}


@dataclass(frozen=True)
class Limits:
    """Bounds on what one run reads, so a hostile tree cannot exhaust the runner."""

    max_file_bytes: int = 1_000_000
    max_depth: int = 100
    max_files: int = 50_000
    max_alias_hops: int = 32
    max_items: int = 2_000


DEFAULT_LIMITS = Limits()


class RequestError(ValueError):
    """The request is malformed; nothing was analysed."""


class GitError(RuntimeError):
    """A Git command failed, for example because a commit is missing."""


class ParseError(Exception):
    """A file could not be parsed. ``kind`` is a stable machine-readable reason."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


# Git access: the only side effects besides reading the request and writing the report.


def _git_env() -> dict[str, str]:
    # Inherited GIT_* variables could point Git at another repository; user config could add filters.
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    env.update(
        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0"
    )
    return env


@dataclass(frozen=True)
class TreeEntry:
    path: str
    oid: str
    size: int


class GitRepo:
    """Read-only access to commits through ``ls-tree`` and ``cat-file``; never a working tree."""

    def __init__(self, path: str) -> None:
        self.path = path

    def _run(self, args: list[str], stdin: bytes | None = None) -> bytes:
        result = subprocess.run(
            ["git", "-C", self.path, "-c", "core.fsmonitor=false", *args],
            input=stdin,
            capture_output=True,
            env=_git_env(),
            check=False,
        )
        if result.returncode != 0:
            message = result.stderr.decode("utf-8", "replace").strip()
            raise GitError(f"git {args[0]} failed: {message}")
        return result.stdout

    def tree(self, sha: str) -> tuple[list[TreeEntry], list[dict]]:
        """List the regular files of a commit, with errors for paths that are not safe to use."""
        output = self._run(
            ["ls-tree", "-r", "-l", "-z", "--full-tree", f"{sha}^{{commit}}"]
        )
        entries, errors = [], []
        for record in output.split(b"\0"):
            if not record:
                continue
            meta, _, raw_path = record.partition(b"\t")
            mode, kind, oid, size = meta.split()
            # Symlinks (120000) and submodules (160000) are never followed.
            if kind != b"blob" or mode not in (b"100644", b"100755"):
                continue
            try:
                path = raw_path.decode("utf-8")
            except UnicodeDecodeError:
                errors.append(
                    _error(
                        "unsafe-path",
                        raw_path.decode("utf-8", "replace"),
                        "path is not UTF-8",
                    )
                )
                continue
            if not is_safe_path(path):
                errors.append(
                    _error(
                        "unsafe-path",
                        path,
                        "path leaves the repository or is not normalised",
                    )
                )
                continue
            entries.append(TreeEntry(path, oid.decode("ascii"), int(size)))
        return entries, errors

    def merge_base(self, one: str, other: str) -> str | None:
        """The best common ancestor of two commits, or None when their histories never meet."""
        result = subprocess.run(
            ["git", "-C", self.path, "-c", "core.fsmonitor=false", "merge-base"]
            + [one, other],
            capture_output=True,
            env=_git_env(),
            check=False,
        )
        # Exit 1 with no output means no common ancestor; anything else is a failure.
        if result.returncode == 1 and not result.stdout and not result.stderr:
            return None
        if result.returncode != 0:
            message = result.stderr.decode("utf-8", "replace").strip()
            raise GitError(f"git merge-base failed: {message}")
        return result.stdout.decode("ascii").strip()

    def blobs(self, oids: list[str]) -> dict[str, bytes]:
        """Read blobs by object ID in one ``cat-file --batch`` call."""
        if not oids:
            return {}
        output = self._run(
            ["cat-file", "--batch"], stdin="\n".join(oids).encode("ascii") + b"\n"
        )
        blobs, offset = {}, 0
        for oid in oids:
            header_end = output.index(b"\n", offset)
            _, kind, size = output[offset:header_end].split()
            if kind != b"blob":
                raise GitError(f"object {oid} is a {kind.decode()}, not a blob")
            start = header_end + 1
            blobs[oid] = output[start : start + int(size)]
            offset = start + int(size) + 1
        return blobs


def is_safe_path(path: str) -> bool:
    """True for a relative, normalised path whose every segment stays inside the repository."""
    if not path or path.startswith("/") or "\\" in path or "\0" in path:
        return False
    if posixpath.normpath(path) != path:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def _error(kind: str, path: str, message: str) -> dict:
    return {"kind": kind, "path": path, "message": message}


# Parsing: bytes to a checked syntax tree.


def parse_source(data: bytes, limits: Limits) -> ast.Module:
    """Parse UTF-8 Python source without executing it, and strip docstrings.

    Raises:
        ParseError: for an oversized file, non-UTF-8 bytes, a syntax error or nesting past the limit.
    """
    if len(data) > limits.max_file_bytes:
        raise ParseError(
            "too-large",
            f"{len(data)} bytes exceeds the limit of {limits.max_file_bytes}",
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ParseError("not-utf8", f"byte {error.start} is not valid UTF-8") from None
    try:
        tree = ast.parse(text.removeprefix("﻿"))
    except SyntaxError as error:
        raise ParseError("syntax", f"line {error.lineno}: {error.msg}") from None
    except (RecursionError, MemoryError):
        raise ParseError("too-deep", "nesting exceeds the parser's limit") from None
    except ValueError as error:
        raise ParseError("syntax", str(error)) from None
    if ast_depth(tree, limits.max_depth) > limits.max_depth:
        raise ParseError(
            "too-deep", f"syntax tree is deeper than {limits.max_depth} levels"
        )
    _strip_docstrings(tree)
    return tree


def ast_depth(tree: ast.AST, limit: int) -> int:
    """Return the tree's depth, stopping once it passes ``limit``; iterative, so no recursion."""
    deepest, stack = 0, [(tree, 1)]
    while stack:
        node, depth = stack.pop()
        deepest = max(deepest, depth)
        if deepest > limit:
            return deepest
        stack.extend((child, depth + 1) for child in ast.iter_child_nodes(node))
    return deepest


def _strip_docstrings(tree: ast.Module) -> None:
    # A docstring edit changes no behaviour, so it must not mark a symbol as changed.
    for node in ast.walk(tree):
        if isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            first = node.body[0] if node.body else None
            value = first.value if isinstance(first, ast.Expr) else None
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                del node.body[0]


def _source(node: ast.AST | None) -> str | None:
    return None if node is None else ast.unparse(node)


# Facts about one file, independent of where it sits in a tree.


@dataclass(frozen=True)
class Param:
    name: str
    kind: str
    annotation: str | None
    default: str | None


@dataclass(frozen=True)
class Signature:
    text: str
    params: tuple[Param, ...]
    returns: str | None
    is_async: bool


@dataclass(frozen=True)
class Shape:
    kind: str
    fields: tuple[tuple[str, str | None, str | None], ...]


@dataclass(frozen=True)
class Definition:
    local: str
    kind: str
    line: int
    fingerprint: str
    body_fingerprint: str
    signature: Signature | None = None
    shape: Shape | None = None
    returns: ast.expr | None = None


@dataclass
class FileFacts:
    tree: ast.Module
    definitions: dict[str, Definition]
    # Top-level bindings from import statements: local name -> (module, name or None, level, line).
    imports: dict[str, tuple[str, str | None, int, int]]
    exports_all: tuple[str, ...] | None


def file_facts(tree: ast.Module) -> FileFacts:
    definitions: dict[str, Definition] = {}
    imports: dict[str, tuple[str, str | None, int, int]] = {}
    exports_all = None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            _collect_definition(node, "", definitions)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [
                name.id
                for target in targets
                for name in ast.walk(target)
                if isinstance(name, ast.Name)
            ]
            if "__all__" in names:
                exports_all = _string_list(node.value)
                continue
            fingerprint = (
                ast.dump(node.value) if node.value is not None else ast.dump(node)
            )
            for name in names:
                definitions[name] = Definition(
                    name, "variable", node.lineno, fingerprint, fingerprint
                )
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname is not None:
                    imports[alias.asname] = (alias.name, None, 0, node.lineno)
                else:
                    head = alias.name.split(".")[0]
                    imports[head] = (head, None, 0, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    imports[alias.asname or alias.name] = (
                        node.module or "",
                        alias.name,
                        node.level,
                        node.lineno,
                    )
    return FileFacts(tree, definitions, imports, exports_all)


def _string_list(node: ast.expr | None) -> tuple[str, ...] | None:
    if isinstance(node, (ast.List, ast.Tuple)) and all(
        isinstance(item, ast.Constant) and isinstance(item.value, str)
        for item in node.elts
    ):
        return tuple(item.value for item in node.elts)
    return None


def _collect_definition(
    node: ast.stmt, prefix: str, out: dict[str, Definition]
) -> None:
    local = f"{prefix}{node.name}"
    fingerprint = ast.dump(node)
    original, node.name = node.name, ""
    body_fingerprint = ast.dump(
        node
    )  # the same definition under any name: rename and move detection
    node.name = original
    if isinstance(node, ast.ClassDef):
        out[local] = Definition(
            local,
            "class",
            node.lineno,
            fingerprint,
            body_fingerprint,
            shape=_shape(node),
        )
        for member in node.body:
            if isinstance(
                member, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                _collect_definition(member, f"{local}.", out)
        return
    kind = "method" if prefix else "function"
    signature = _signature(node)
    out[local] = Definition(
        local,
        kind,
        node.lineno,
        fingerprint,
        body_fingerprint,
        signature=signature,
        returns=node.returns,
    )


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> Signature:
    args = node.args
    positional = [*args.posonlyargs, *args.args]
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    params = [
        Param(
            arg.arg,
            "positional-only" if index < len(args.posonlyargs) else "positional",
            _source(arg.annotation),
            _source(default),
        )
        for index, (arg, default) in enumerate(zip(positional, defaults, strict=True))
    ]
    if args.vararg is not None:
        params.append(
            Param(
                args.vararg.arg, "var-positional", _source(args.vararg.annotation), None
            )
        )
    for arg, default in zip(args.kwonlyargs, args.kw_defaults, strict=True):
        params.append(
            Param(arg.arg, "keyword-only", _source(arg.annotation), _source(default))
        )
    if args.kwarg is not None:
        params.append(
            Param(args.kwarg.arg, "var-keyword", _source(args.kwarg.annotation), None)
        )
    returns = _source(node.returns)
    is_async = isinstance(node, ast.AsyncFunctionDef)
    text = f"{'async ' if is_async else ''}({ast.unparse(args)})" + (
        f" -> {returns}" if returns else ""
    )
    return Signature(text, tuple(params), returns, is_async)


def _last_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return None


def _shape(node: ast.ClassDef) -> Shape | None:
    kind = None
    if any(
        _last_name(decorator) in RECORD_DECORATORS for decorator in node.decorator_list
    ):
        kind = "dataclass"
    for base in node.bases:
        kind = kind or RECORD_BASES.get(_last_name(base) or "")
    if kind is None:
        return None
    fields = []
    for member in node.body:
        if (
            kind != "enum"
            and isinstance(member, ast.AnnAssign)
            and isinstance(member.target, ast.Name)
        ):
            annotation = ast.unparse(member.annotation)
            if not annotation.startswith(("ClassVar", "typing.ClassVar")):
                fields.append((member.target.id, annotation, _source(member.value)))
        elif kind == "enum" and isinstance(member, ast.Assign):
            for target in member.targets:
                if isinstance(target, ast.Name):
                    fields.append((target.id, None, ast.unparse(member.value)))
    return Shape(kind, tuple(fields))


# Trees: every file of one commit, its module names and its import aliases.


def module_name(path: str) -> str | None:
    """The dotted module a path is imported as, or None when no import statement can name it."""
    if not path.endswith(".py"):
        return None
    parts = path[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    if not parts or not all(
        part.isidentifier() and not keyword.iskeyword(part) for part in parts
    ):
        return None
    return ".".join(parts)


def resolve_relative(
    module: str, is_package: bool, target: str, level: int
) -> str | None:
    """Resolve ``from <level dots><target> import`` inside ``module`` to an absolute module name."""
    if level == 0:
        return target
    parts = module.split(".") if is_package else module.split(".")[:-1]
    if level - 1 > len(parts):
        return None
    base = parts[: len(parts) - (level - 1)]
    return ".".join([*base, target] if target else base) or None


@dataclass
class SourceFile:
    path: str
    oid: str
    module: str | None
    facts: FileFacts | None


@dataclass
class ScopeMap:
    paths: list[tuple[str, str]]  # (prefix, scope id), longest prefix first
    contracts: dict[str, str]  # "path::symbol" -> scope id

    def scope_of(self, path: str) -> str | None:
        for prefix, scope in self.paths:
            if path == prefix or path.startswith(prefix + "/"):
                return scope
        return None


def parse_scope_map(data: bytes | None) -> tuple[ScopeMap, str | None]:
    """Read scope paths and contracts from ``penguin/scopes.json``; returns an error text when invalid."""
    empty = ScopeMap([], {})
    if data is None:
        return empty, f"{SCOPES_FILE} is missing"
    try:
        raw = json.loads(data.decode("utf-8"))
        paths, contracts = [], {}
        for scope in raw["scopes"]:
            scope_id = scope["id"]
            if not isinstance(scope_id, str) or not scope_id:
                raise ValueError("a scope id is not a string")
            for prefix in scope["paths"]:
                paths.append((str(prefix).rstrip("/"), scope_id))
            for contract in scope.get("contracts", []):
                contracts[str(contract)] = scope_id
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        return empty, f"{SCOPES_FILE} is invalid: {error}"
    paths.sort(key=lambda item: (-len(item[0]), item[0]))
    return ScopeMap(paths, contracts), None


@dataclass
class Tree:
    """One commit's Python files and the symbol tables derived from them."""

    name: str
    sha: str
    entries: dict[str, str]  # path -> blob oid, every regular file
    files: dict[str, SourceFile]
    errors: list[dict]
    scopes: ScopeMap
    limits: Limits
    modules: dict[str, SourceFile] = field(default_factory=dict)
    definitions: dict[str, tuple[Definition, SourceFile]] = field(default_factory=dict)
    aliases: dict[str, str] = field(default_factory=dict)
    _members: dict[str, list[str]] | None = None

    def __post_init__(self) -> None:
        for source in self.files.values():
            if source.module is None or source.facts is None:
                continue
            self.modules[source.module] = source
            for local, definition in source.facts.definitions.items():
                self.definitions[f"{source.module}.{local}"] = (definition, source)
            for local, target in source.facts.imports.items():
                resolved = self.import_target(source, target)
                if resolved is not None:
                    self.aliases[f"{source.module}.{local}"] = resolved

    def import_target(
        self, source: SourceFile, target: tuple[str, str | None, int, int]
    ) -> str | None:
        module, name, level, _ = target
        if source.module is None:
            base = module if level == 0 else None
        else:
            base = resolve_relative(
                source.module, source.path.endswith("__init__.py"), module, level
            )
        if base is None:
            return None
        return base if name is None else f"{base}.{name}"

    def canonical_chain(self, name: str) -> list[str]:
        """Follow import aliases from ``name`` to where it is defined; every name visited, in order."""
        chain = [name]
        for _ in range(self.limits.max_alias_hops):
            if name in self.definitions or name in self.modules:
                break
            parts = name.split(".")
            for cut in range(len(parts), 0, -1):
                prefix = ".".join(parts[:cut])
                if prefix in self.aliases:
                    name = ".".join([self.aliases[prefix], *parts[cut:]])
                    break
            else:
                break
            if name in chain:
                break
            chain.append(name)
        return chain

    def members(self) -> dict[str, list[str]]:
        """Each class's nested definitions, by the class's dotted name."""
        if self._members is None:
            self._members = defaultdict(list)
            for full, (definition, source) in self.definitions.items():
                parts = definition.local.split(".")
                for cut in range(1, len(parts)):
                    self._members[f"{source.module}.{'.'.join(parts[:cut])}"].append(
                        full
                    )
        return self._members

    def canonical(self, name: str) -> str:
        return self.canonical_chain(name)[-1]


def load_tree(repo: GitRepo, name: str, sha: str, cache: dict, limits: Limits) -> Tree:
    """Read and parse one commit's Python files. ``cache`` maps blob IDs to facts across trees."""
    listed, errors = repo.tree(sha)
    entries = {entry.path: entry.oid for entry in listed}
    python = [entry for entry in listed if entry.path.endswith(".py")]
    if len(python) > limits.max_files:
        errors.append(
            _error(
                "too-many-files",
                "",
                f"{len(python)} Python files exceeds {limits.max_files}",
            )
        )
        python = python[: limits.max_files]
    wanted = [
        entry
        for entry in python
        if entry.oid not in cache and entry.size <= limits.max_file_bytes
    ]
    scopes_oid = entries.get(SCOPES_FILE)
    blobs = repo.blobs(
        sorted(
            {entry.oid for entry in wanted} | ({scopes_oid} if scopes_oid else set())
        )
    )
    files = {}
    for entry in python:
        if entry.oid not in cache:
            if entry.size > limits.max_file_bytes:
                cache[entry.oid] = ParseError(
                    "too-large",
                    f"{entry.size} bytes exceeds the limit of {limits.max_file_bytes}",
                )
            else:
                try:
                    cache[entry.oid] = file_facts(
                        parse_source(blobs[entry.oid], limits)
                    )
                except ParseError as error:
                    cache[entry.oid] = error
        facts = cache[entry.oid]
        if isinstance(facts, ParseError):
            errors.append(_error(facts.kind, entry.path, str(facts)))
            facts = None
        files[entry.path] = SourceFile(
            entry.path, entry.oid, module_name(entry.path), facts
        )
    scope_map, scope_error = parse_scope_map(
        blobs.get(scopes_oid) if scopes_oid else None
    )
    if scope_error is not None:
        errors.append(_error("scopes", SCOPES_FILE, scope_error))
    return Tree(name, sha, entries, files, errors, scope_map, limits)


# The contract diff: what changed between the base and head trees.


@dataclass(frozen=True)
class ViewEntry:
    """One public name of a tree with the definition it stands for."""

    symbol: str
    module: str
    path: str
    line: int
    definition: Definition
    origin: str  # the module.qualname where the definition lives


def public_view(tree: Tree) -> dict[str, ViewEntry]:
    """Every definition by its dotted name, plus each name a module re-exports through ``__all__``.

    A re-export is materialised under the exporting module's name, members included, so a re-export
    that now points at another definition diffs like an edited definition.
    """
    view = {}
    for full, (definition, source) in tree.definitions.items():
        view[full] = ViewEntry(
            full, source.module, source.path, definition.line, definition, full
        )
    for module, source in tree.modules.items():
        for name in source.facts.exports_all or ():
            full = f"{module}.{name}"
            if full in view:
                continue
            line = source.facts.imports.get(name, (None, None, 0, 1))[3]
            target = tree.canonical(full)
            if target not in tree.definitions:
                fingerprint = f"external {target}"
                external = Definition(name, "alias", line, fingerprint, fingerprint)
                view[full] = ViewEntry(
                    full, module, source.path, line, external, target
                )
                continue
            for member in [target, *tree.members().get(target, ())]:
                alias = full + member[len(target) :]
                view[alias] = ViewEntry(
                    alias,
                    module,
                    source.path,
                    line,
                    tree.definitions[member][0],
                    member,
                )
    return view


def _parent(symbol: str, module: str) -> str:
    return symbol.rsplit(".", 1)[0] if symbol.count(".") > module.count(".") else module


def _local(entry: ViewEntry) -> str:
    return entry.symbol[len(entry.module) + 1 :]


def diff_views(base: dict[str, ViewEntry], head: dict[str, ViewEntry]) -> list[dict]:
    """Classify each symbol as modified, added, removed, renamed or moved."""
    removed = sorted(base.keys() - head.keys())
    added = sorted(head.keys() - base.keys())
    # A removed and an added definition with the same body under another name or module are one
    # rename or move. Matching is by exact fingerprint through a dict, so it stays linear.
    candidates: dict[tuple[str, str], list[str]] = defaultdict(list)
    for symbol in added:
        definition = head[symbol].definition
        if definition.kind in ("function", "method", "class"):
            candidates[(definition.kind, definition.body_fingerprint)].append(symbol)
    pairs: dict[str, str] = {}
    for symbol in removed:
        definition = base[symbol].definition
        matches = candidates.get((definition.kind, definition.body_fingerprint))
        if matches:
            pairs[symbol] = matches.pop(0)
    # Members of a renamed or moved class move with it and are not listed again.
    carried_base = tuple(
        f"{old}." for old, new in pairs.items() if base[old].definition.kind == "class"
    )
    carried_head = tuple(
        f"{new}." for old, new in pairs.items() if base[old].definition.kind == "class"
    )

    changes = []
    for symbol in sorted(base.keys() & head.keys()):
        before, after = base[symbol], head[symbol]
        if before.definition.fingerprint != after.definition.fingerprint:
            change = _change(after, "modified")
            if before.origin != after.origin:
                change["origin"] = {"before": before.origin, "after": after.origin}
            changes.append(change)
    for symbol in removed:
        if symbol.startswith(carried_base):
            continue
        entry = base[symbol]
        if symbol in pairs:
            target = head[pairs[symbol]]
            same_parent = _parent(symbol, entry.module) == _parent(
                target.symbol, target.module
            )
            change = _change(entry, "renamed" if same_parent else "moved")
            change["to"] = {
                "symbol": target.symbol,
                "path": target.path,
                "line": target.line,
            }
            changes.append(change)
        else:
            changes.append(_change(entry, "removed"))
    paired_targets = set(pairs.values())
    for symbol in added:
        if symbol in paired_targets or symbol.startswith(carried_head):
            continue
        changes.append(_change(head[symbol], "added"))
    changes.sort(
        key=lambda change: (change["path"], change["symbol"], change["change"])
    )
    return changes


def _change(entry: ViewEntry, change: str) -> dict:
    return {
        "symbol": entry.symbol,
        "path": entry.path,
        "line": entry.line,
        "kind": entry.definition.kind,
        "change": change,
    }


def diff_signature(before: Signature, after: Signature) -> dict | None:
    """Compare two signatures; None when they are the same."""
    if before == after:
        return None
    old = {param.name: param for param in before.params}
    new = {param.name: param for param in after.params}
    reasons = []
    added = [param for param in after.params if param.name not in old]
    removed = [param for param in before.params if param.name not in new]
    for param in removed:
        if param.kind not in VARIADIC:
            reasons.append(f"removes parameter {param.name}")
    for param in added:
        if param.kind not in VARIADIC and param.default is None:
            reasons.append(f"adds required parameter {param.name}")
    for name in sorted(old.keys() & new.keys()):
        if old[name].kind != new[name].kind:
            reasons.append(f"changes {name} from {old[name].kind} to {new[name].kind}")
        if old[name].default is not None and new[name].default is None:
            reasons.append(f"removes the default of {name}")
    old_order = [
        param.name
        for param in before.params
        if param.kind in POSITIONAL and param.name in new
    ]
    new_order = [
        param.name
        for param in after.params
        if param.kind in POSITIONAL and param.name in old
    ]
    if old_order != new_order:
        reasons.append("reorders positional parameters")
    if before.is_async != after.is_async:
        reasons.append("changes between sync and async")
    return {
        "before": before.text,
        "after": after.text,
        "added": [
            {
                "name": param.name,
                "required": param.default is None and param.kind not in VARIADIC,
            }
            for param in added
        ],
        "removed": [param.name for param in removed],
        "breaking": bool(reasons),
        "reasons": reasons,
    }


def _field_text(name: str, annotation: str | None, default: str | None) -> str:
    text = name if annotation is None else f"{name}: {annotation}"
    return text if default is None else f"{text} = {default}"


def diff_shape(before: Shape | None, after: Shape | None) -> dict | None:
    """Compare two record shapes; None when they are the same or neither class is a record."""
    if before == after or (before is None and after is None):
        return None
    old = {
        name: (name, annotation, default)
        for name, annotation, default in (before.fields if before else ())
    }
    new = {
        name: (name, annotation, default)
        for name, annotation, default in (after.fields if after else ())
    }
    common_old = [name for name in old if name in new]
    common_new = [name for name in new if name in old]
    return {
        "kind": (after or before).kind,
        "before": [_field_text(*item) for item in old.values()],
        "after": [_field_text(*item) for item in new.values()],
        "added": [name for name in new if name not in old],
        "removed": [name for name in old if name not in new],
        "changed": sorted(name for name in common_old if old[name] != new[name]),
        "reordered": common_old != common_new,
    }


def contract_of(path: str, local: str, contracts: dict[str, str]) -> str | None:
    """The declared contract (``path::symbol``) that covers a symbol, or None."""
    parts = local.split(".")
    for cut in range(len(parts), 0, -1):
        contract = f"{path}::{'.'.join(parts[:cut])}"
        if contract in contracts:
            return contract
    return None


@dataclass
class ContractDiff:
    changes: list[dict]
    signatures: list[dict]
    data_shapes: list[dict]
    removed_exports: list[dict]
    contracts: list[str]


def contract_diff(base: Tree, head: Tree) -> ContractDiff:
    base_view, head_view = public_view(base), public_view(head)
    changes = diff_views(base_view, head_view)
    signatures, shapes, contracts = [], [], set()
    for change in changes:
        entry = head_view.get(change["symbol"]) or base_view[change["symbol"]]
        contract = contract_of(entry.path, _local(entry), head.scopes.contracts)
        change["scope"] = head.scopes.scope_of(entry.path) or base.scopes.scope_of(
            entry.path
        )
        change["contract"] = contract
        if contract is not None:
            contracts.add(contract)
        if change["change"] != "modified":
            continue
        before, after = base_view[change["symbol"]].definition, entry.definition
        location = {"symbol": change["symbol"], "path": entry.path, "line": entry.line}
        if before.signature is not None and after.signature is not None:
            signature = diff_signature(before.signature, after.signature)
            if signature is not None:
                signatures.append({**location, **signature})
        shape = diff_shape(before.shape, after.shape)
        if shape is not None:
            shapes.append({**location, **shape})
    return ContractDiff(
        changes, signatures, shapes, removed_exports(base, head), sorted(contracts)
    )


def _exports(source: SourceFile) -> set[str]:
    if source.facts.exports_all is not None:
        return set(source.facts.exports_all)
    return {
        local
        for local, definition in source.facts.definitions.items()
        if "." not in local and not local.startswith("_")
    }


def removed_exports(base: Tree, head: Tree) -> list[dict]:
    """Names a module exported at base that an import of the module at head can no longer reach."""
    removed = []
    for module, source in base.modules.items():
        exported = _exports(source)
        target = head.modules.get(module)
        if target is None and source.path in head.files:
            continue  # the module is still there but did not parse; it is listed under errors
        for name in sorted(exported):
            if target is not None:
                if target.facts.exports_all is not None:
                    if name in target.facts.exports_all:
                        continue
                elif (
                    f"{module}.{name}" in head.definitions
                    or f"{module}.{name}" in head.aliases
                ):
                    continue
            removed.append({"module": module, "path": source.path, "name": name})
    removed.sort(key=lambda item: (item["path"], item["name"]))
    return removed


# The impact graph: where each tree imports, calls or references a changed symbol.


class UseFinder(ast.NodeVisitor):
    """Walks one file and records every import, call and reference that reaches a changed symbol.

    Names are resolved through the file's imports and the tree's aliases. A local variable's class
    comes from a parameter or variable annotation, a constructor call, or the annotated return type
    of the called function, so ``identity_map.resolve(...)`` resolves to a method when
    ``identity_map`` is annotated with its class.
    """

    def __init__(self, tree: Tree, source: SourceFile, changed: dict[str, str]) -> None:
        self.tree = tree
        self.source = source
        self.changed = changed
        self.scopes: list[dict[str, tuple[str, str]]] = [{}]
        self.uses: dict[tuple[int, str, str], str] = {}
        self.call_funcs: set[int] = set()

    # Name binding and lookup.

    def bind(self, name: str, kind: str, target: str) -> None:
        self.scopes[-1][name] = (kind, target)

    def lookup(self, name: str) -> tuple[str, str] | None:
        for scope in reversed(self.scopes):
            if name in scope:
                return scope[name]
        module = self.source.module
        if module is not None and f"{module}.{name}" in self.tree.definitions:
            return ("ref", f"{module}.{name}")
        return None

    def dotted(self, node: ast.expr) -> str | None:
        """The fully qualified name an expression names, or None when it names nothing static."""
        attrs = []
        while isinstance(node, ast.Attribute):
            attrs.append(node.attr)
            node = node.value
        if not isinstance(node, ast.Name):
            return None
        bound = self.lookup(node.id)
        if bound is None:
            return None
        return ".".join([bound[1], *reversed(attrs)])

    def class_of_annotation(
        self, node: ast.expr | None, module_source: SourceFile | None = None
    ) -> str | None:
        """The class an annotation names, ignoring ``None`` and ``Optional`` wrappers."""
        if node is None:
            return None
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            try:
                node = ast.parse(node.value, mode="eval").body
            except SyntaxError:
                return None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return self.class_of_annotation(
                node.left, module_source
            ) or self.class_of_annotation(node.right, module_source)
        if isinstance(node, ast.Subscript) and _last_name(node.value) == "Optional":
            return self.class_of_annotation(node.slice, module_source)
        name = (
            self.dotted(node)
            if module_source is None
            else _module_dotted(self.tree, module_source, node)
        )
        if name is None:
            return None
        found = self.tree.definitions.get(self.tree.canonical(name))
        return name if found is not None and found[0].kind == "class" else None

    def element_class(
        self, node: ast.expr | None, module_source: SourceFile
    ) -> str | None:
        """The element class of an annotated container such as ``list[Profile]``."""
        if isinstance(node, ast.Subscript):
            item = (
                node.slice.elts[0]
                if isinstance(node.slice, ast.Tuple) and node.slice.elts
                else node.slice
            )
            return self.class_of_annotation(item, module_source)
        return None

    def infer(self, value: ast.expr) -> tuple[str, str] | None:
        """What a value is: an instance of a class (``inst``) or an iterable of one (``iter``)."""
        if not isinstance(value, ast.Call):
            return None
        callee = self.resolve_member(value.func)
        if callee is None:
            return None
        found = self.tree.definitions.get(self.tree.canonical(callee))
        if found is None:
            return None
        definition, source = found
        if definition.kind == "class":
            return ("inst", callee)
        if definition.returns is None:
            return None
        element = self.element_class(definition.returns, source)
        if element is not None:
            return ("iter", element)
        instance = self.class_of_annotation(definition.returns, source)
        return ("inst", instance) if instance is not None else None

    def resolve_member(self, node: ast.expr) -> str | None:
        """Resolve a name or attribute chain, including attributes of typed local variables.

        The result keeps the names as the file spells them; ``match`` follows the aliases, so a
        change listed under a re-exporting module's name still matches.
        """
        attrs = []
        base = node
        while isinstance(base, ast.Attribute):
            attrs.append(base.attr)
            base = base.value
        if not isinstance(base, ast.Name):
            return None
        bound = self.lookup(base.id)
        if bound is None or bound[0] == "iter" or (bound[0] == "inst" and not attrs):
            return None
        return ".".join([bound[1], *reversed(attrs)])

    # Recording.

    def match(self, name: str) -> str | None:
        for candidate in self.tree.canonical_chain(name):
            if candidate in self.changed:
                return candidate
        return None

    def record(self, node: ast.AST, name: str | None, kind: str) -> bool:
        if name is None:
            return False
        symbol = self.match(name)
        if symbol is None:
            return False
        key = (node.lineno, symbol, kind)
        self.uses.setdefault(key, name)
        return True

    # Visitors.

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.asname is not None:
                self.bind(alias.asname, "ref", alias.name)
            else:
                head = alias.name.split(".")[0]
                self.bind(head, "ref", head)
            self.record(node, alias.name, "import")

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        target = (node.module or "", None, node.level, node.lineno)
        base = self.tree.import_target(self.source, target)
        if base is None:
            return
        for alias in node.names:
            if alias.name == "*":
                continue
            full = f"{base}.{alias.name}"
            self.bind(alias.asname or alias.name, "ref", full)
            self.record(node, full, "import")

    def visit_Call(self, node: ast.Call) -> None:
        self.call_funcs.add(id(node.func))
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.record_reference(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.ctx, ast.Load) and self.record_reference(node):
            return
        self.generic_visit(node)

    def record_reference(self, node: ast.expr) -> bool:
        kind = "call" if id(node) in self.call_funcs else "reference"
        return self.record(node, self.resolve_member(node), kind)

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        self.visit(node.args)
        if node.returns is not None:
            self.visit(node.returns)
        self.bind(node.name, "ref", self._local_name(node.name))
        self.scopes.append({})
        args = node.args
        for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
            cls = self.class_of_annotation(arg.annotation)
            if cls is not None:
                self.bind(arg.arg, "inst", cls)
        for statement in node.body:
            self.visit(statement)
        self.scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for expression in [*node.decorator_list, *node.bases, *node.keywords]:
            self.visit(expression)
        self.scopes.append({})
        for statement in node.body:
            self.visit(statement)
        self.scopes.pop()

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        inferred = self.infer(node.value)
        for target in node.targets:
            if isinstance(target, ast.Name) and inferred is not None:
                self.bind(target.id, *inferred)
            else:
                self.visit(target)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self.visit(node.annotation)
        if node.value is not None:
            self.visit(node.value)
        cls = self.class_of_annotation(node.annotation)
        if isinstance(node.target, ast.Name) and cls is not None:
            self.bind(node.target.id, "inst", cls)

    def bind_loop(self, target: ast.expr, iterable: ast.expr) -> None:
        inferred = self.infer(iterable)
        if inferred is None and isinstance(iterable, ast.Name):
            inferred = self.lookup(iterable.id)
        if (
            isinstance(target, ast.Name)
            and inferred is not None
            and inferred[0] == "iter"
        ):
            self.bind(target.id, "inst", inferred[1])

    def visit_For(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self.bind_loop(node.target, node.iter)
        for statement in [*node.body, *node.orelse]:
            self.visit(statement)

    visit_AsyncFor = visit_For

    def visit_comprehension(self, node: ast.comprehension) -> None:
        self.visit(node.iter)
        self.bind_loop(node.target, node.iter)
        for condition in node.ifs:
            self.visit(condition)

    def _visit_comprehension_expression(
        self, node: ast.AST, elements: list[ast.expr]
    ) -> None:
        # Generators bind first; the element expressions read those bindings.
        self.scopes.append({})
        for generator in node.generators:
            self.visit(generator)
        for element in elements:
            self.visit(element)
        self.scopes.pop()

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_comprehension_expression(node, [node.elt])

    visit_SetComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_comprehension_expression(node, [node.key, node.value])

    def _local_name(self, name: str) -> str:
        return f"{self.source.module}.{name}" if self.source.module else name


def _module_dotted(tree: Tree, source: SourceFile, node: ast.expr) -> str | None:
    """Resolve a name in another module's top-level namespace, such as a return annotation."""
    attrs = []
    while isinstance(node, ast.Attribute):
        attrs.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name) or source.facts is None:
        return None
    if node.id in source.facts.imports:
        base = tree.import_target(source, source.facts.imports[node.id])
    elif node.id in source.facts.definitions and source.module is not None:
        base = f"{source.module}.{node.id}"
    else:
        return None
    return None if base is None else ".".join([base, *reversed(attrs)])


def find_uses(
    tree: Tree,
    changed: dict[str, str],
    scope_ids: set[str] | None,
    skip_paths: set[str],
) -> list[dict]:
    """Every use of a changed symbol in the tree's files, limited to the given scopes when named."""
    uses = []
    for path in sorted(tree.files):
        source = tree.files[path]
        scope = tree.scopes.scope_of(path)
        if source.facts is None or path in skip_paths:
            continue
        if scope_ids is not None and scope not in scope_ids:
            continue
        finder = UseFinder(tree, source, changed)
        finder.visit(source.facts.tree)
        for (line, symbol, kind), name in finder.uses.items():
            uses.append(
                {
                    "path": path,
                    "line": line,
                    "kind": kind,
                    "symbol": symbol,
                    "name": name,
                    "scope": scope,
                }
            )
    uses.sort(key=lambda use: (use["path"], use["line"], use["symbol"], use["kind"]))
    return uses


def changed_symbols(diff: ContractDiff, head: Tree, base: Tree) -> dict[str, str]:
    """Symbols whose callers are affected, plus each module that holds one, mapped to its path."""
    changed = {}
    for change in diff.changes:
        if change["change"] in CALLER_CHANGES:
            changed[change["symbol"]] = change["path"]
            source = head.files.get(change["path"]) or base.files.get(change["path"])
            if source is not None and source.module is not None:
                changed[source.module] = change["path"]
    return changed


# The run: request in, report out.


@dataclass(frozen=True)
class ForkRequest:
    id: str
    sha: str
    scopes: tuple[str, ...]
    # Main's commit: uses count only in files the fork changed since its merge base with it.
    since: str | None = None


@dataclass(frozen=True)
class AnalysisRequest:
    base: str
    head: str
    forks: tuple[ForkRequest, ...]


def parse_request(raw: object) -> AnalysisRequest:
    """Check a request's fields.

    Raises:
        RequestError: naming the first invalid field.
    """
    if not isinstance(raw, dict):
        raise RequestError("the request must be a JSON object")
    for key in ("base", "head"):
        if not isinstance(raw.get(key), str) or not SHA.match(raw[key]):
            raise RequestError(f"{key} must be a full lowercase commit SHA")
    forks_raw = raw.get("forks", [])
    if not isinstance(forks_raw, list) or len(forks_raw) > MAX_FORKS:
        raise RequestError(f"forks must be an array of at most {MAX_FORKS} forks")
    forks, seen = [], set()
    for index, fork in enumerate(forks_raw):
        if not isinstance(fork, dict):
            raise RequestError(f"forks[{index}] must be an object")
        fork_id, sha, scopes = fork.get("id"), fork.get("sha"), fork.get("scopes", [])
        since = fork.get("since")
        if (
            not isinstance(fork_id, str)
            or not FORK_ID.match(fork_id)
            or fork_id in seen
        ):
            raise RequestError(f"forks[{index}].id must be a unique fork id")
        if not isinstance(sha, str) or not SHA.match(sha):
            raise RequestError(
                f"forks[{index}].sha must be a full lowercase commit SHA"
            )
        if not isinstance(scopes, list) or not all(
            isinstance(scope, str) and 0 < len(scope) <= 128 for scope in scopes
        ):
            raise RequestError(f"forks[{index}].scopes must be an array of scope ids")
        if since is not None and (not isinstance(since, str) or not SHA.match(since)):
            raise RequestError(
                f"forks[{index}].since must be a full lowercase commit SHA"
            )
        seen.add(fork_id)
        forks.append(ForkRequest(fork_id, sha, tuple(sorted(set(scopes))), since))
    return AnalysisRequest(raw["base"], raw["head"], tuple(forks))


def unanalysed_paths(base: Tree, head: Tree) -> list[str]:
    """Changed paths whose effect this analysis cannot see: anything but a parsed, importable module."""
    unanalysed = []
    for path in sorted(base.entries.keys() | head.entries.keys()):
        if base.entries.get(path) == head.entries.get(path):
            continue
        sides = [tree.files.get(path) for tree in (base, head) if path in tree.entries]
        if not all(
            side is not None and side.module is not None and side.facts is not None
            for side in sides
        ):
            unanalysed.append(path)
    return unanalysed


def own_paths(
    repo: GitRepo, fork: ForkRequest, tree: Tree, listed: dict
) -> tuple[str | None, set[str] | None]:
    """The fork's merge base with ``since`` and the paths it added or changed since then.

    None for the paths means every path counts: no ``since``, or no common ancestor. ``listed``
    caches each merge base's entries, since most forks share one.
    """
    if fork.since is None:
        return None, None
    merge_base = repo.merge_base(fork.since, fork.sha)
    if merge_base is None:
        return None, None
    if merge_base not in listed:
        entries, _ = repo.tree(merge_base)
        listed[merge_base] = {entry.path: entry.oid for entry in entries}
    before = listed[merge_base]
    return merge_base, {
        path for path, oid in tree.entries.items() if before.get(path) != oid
    }


def _cap(items: list, limits: Limits, truncated: list[bool]) -> list:
    if len(items) > limits.max_items:
        truncated[0] = True
        return items[: limits.max_items]
    return items


def analyse(
    repo: GitRepo, request: AnalysisRequest, limits: Limits = DEFAULT_LIMITS
) -> dict:
    """Build the impact graph and contract diff for a request and return the report."""
    cache: dict = {}
    base = load_tree(repo, "base", request.base, cache, limits)
    head = load_tree(repo, "head", request.head, cache, limits)
    diff = contract_diff(base, head)
    changed = changed_symbols(diff, head, base)
    unanalysed = unanalysed_paths(base, head)
    changed_paths = set(unanalysed) | {
        path
        for path in base.entries.keys() | head.entries.keys()
        if base.entries.get(path) != head.entries.get(path)
    }
    truncated = [False]

    forks = []
    merge_bases: dict = {}
    for fork in request.forks:
        tree = load_tree(repo, fork.id, fork.sha, cache, limits)
        scope_ids = set(fork.scopes) if fork.scopes else None
        merge_base, own = own_paths(repo, fork, tree, merge_bases)
        uses = find_uses(tree, changed, scope_ids, set())
        # A carried file is main's: its unreadable file is main's too, like its callers.
        errors = [
            error
            for error in tree.errors
            if (
                scope_ids is None
                or not error["path"]
                or tree.scopes.scope_of(error["path"]) in scope_ids
            )
            and (own is None or not error["path"] or error["path"] in own)
        ]
        entry = {"id": fork.id, "sha": fork.sha, "scopes": list(fork.scopes)}
        if fork.since is not None:
            own_uses = [use for use in uses if own is None or use["path"] in own]
            entry |= {
                "since": fork.since,
                "mergeBase": merge_base,
                "carried": len(uses) - len(own_uses),
            }
            uses = own_uses
        entry |= {
            "uses": _cap(uses, limits, truncated),
            "errors": _cap(errors, limits, truncated),
        }
        forks.append(entry)

    # Uses inside the files that define a changed symbol are the change itself, not its callers.
    defining = set(changed.values())
    head_uses = find_uses(head, changed, None, defining)
    errors = [
        {**error, "tree": tree.name}
        for tree in (base, head)
        for error in tree.errors
        if not error["path"] or error["path"] in changed_paths
    ]
    errors.sort(key=lambda error: (error["tree"], error["path"], error["kind"]))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "tool": TOOL,
        "commandId": COMMAND_ID,
        "base": request.base,
        "head": request.head,
        "changes": _cap(diff.changes, limits, truncated),
        "signatures": _cap(diff.signatures, limits, truncated),
        "removedExports": _cap(diff.removed_exports, limits, truncated),
        "dataShapes": _cap(diff.data_shapes, limits, truncated),
        "contracts": diff.contracts,
        "headUses": _cap(head_uses, limits, truncated),
        "forks": forks,
        "unanalysed": _cap(unanalysed, limits, truncated),
        "errors": _cap(errors, limits, truncated),
        "complete": not unanalysed and not truncated[0],
        "truncated": truncated[0],
        "files": {
            "base": len(base.files),
            "head": len(head.files),
            "parsed": len(cache),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--repo",
        required=True,
        help="path of the Git repository that holds every commit",
    )
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise RequestError(f"the request exceeds {MAX_REQUEST_BYTES} bytes")
        try:
            request = parse_request(json.loads(raw))
        except json.JSONDecodeError as error:
            raise RequestError(f"the request is not JSON: {error.msg}") from None
        report = analyse(GitRepo(args.repo), request)
    except (RequestError, GitError) as error:
        sys.stderr.write(f"{TOOL}: {error}\n")
        return 2
    sys.stdout.write(json.dumps(report, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
