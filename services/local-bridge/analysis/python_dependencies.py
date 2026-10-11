"""Dependency diff for Python, read from Git trees with the standard library only.

Usage: python3 -I python_dependencies.py --repo PATH < request.json

The request is the impact analysis request: ``{"base": SHA, "head": SHA, "forks": [{"id": ID,
"sha": SHA, "scopes": [SCOPE ID, ...]}]}``. The report on standard output lists each library whose
declared or locked version differs between ``base`` and ``head``, and each place in each fork's
scopes that imports one of them, with its file and line.

A library's version comes from three places:

- ``pyproject.toml``: ``[project] dependencies``, ``[project.optional-dependencies]`` and
  ``[dependency-groups]``, as the requirement's specifier, such as ``>=2.0``;
- ``requirements*.txt``: each requirement line's specifier;
- ``uv.lock``: each ``[[package]]``'s ``version``;
- vendored code: a module whose top level assigns ``__version__`` a string, or imports
  ``__version__`` from a module that does. The module is the library's name.

Source is never imported or executed. Paths come from ``git ls-tree`` and bytes from ``git
cat-file``; TOML is read with ``tomllib`` and Python with ``ast.parse``.
"""

import argparse
import ast
import json
import os
import posixpath
import re
import sys
import tomllib
from dataclasses import dataclass

# The analysis is the bridge's own code: its folder, never the working directory, supplies the
# shared Git and parsing helpers. Isolated mode (-I) leaves both off the import path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from python_impact import (
    DEFAULT_LIMITS,
    MAX_REQUEST_BYTES,
    SCOPES_FILE,
    GitError,
    GitRepo,
    Limits,
    ParseError,
    RequestError,
    ScopeMap,
    TreeEntry,
    _error,
    module_name,
    parse_request,
    parse_scope_map,
    parse_source,
    resolve_relative,
)

TOOL = "python-dependencies"
COMMAND_ID = "analysis:python-dependencies"
SCHEMA_VERSION = 1

REQUIREMENTS = re.compile(r"^requirements[A-Za-z0-9._-]*\.txt$")
# PEP 508: a name, optional extras, then the version specifier and markers.
REQUIREMENT = re.compile(
    r"^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$"
)
MAX_VERSION_HOPS = 8


@dataclass(frozen=True)
class Pin:
    """One library's version as one file states it."""

    name: str
    version: str
    source: str
    path: str
    modules: tuple[str, ...]
    # For vendored code: the module whose ``__version__`` literal the pinned module exposes.
    origin: str | None = None


def normalise(name: str) -> str:
    """The PEP 503 normalised name of a distribution."""
    return re.sub(r"[-_.]+", "-", name).lower()


def import_name(name: str) -> str:
    """The module a distribution is usually imported as: its normalised name with underscores."""
    return normalise(name).replace("-", "_")


def _specifier(text: str) -> tuple[str, str] | None:
    match = REQUIREMENT.match(text.split(";", 1)[0])
    if match is None:
        return None
    return match.group(1), match.group(3).strip() or "*"


def manifest_pins(path: str, data: bytes) -> tuple[list[Pin], str | None]:
    """The pins a manifest or lockfile states, or an error text when it cannot be read."""
    name = posixpath.basename(path)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return [], "not UTF-8"
    requirements: list[str] = []
    pins: list[Pin] = []
    if name == "uv.lock" or name == "pyproject.toml":
        try:
            document = tomllib.loads(text)
        except tomllib.TOMLDecodeError as error:
            return [], f"not TOML: {error}"
        if name == "uv.lock":
            for package in document.get("package", []):
                if isinstance(package, dict) and isinstance(package.get("name"), str):
                    version = package.get("version")
                    library = normalise(package["name"])
                    pins.append(
                        Pin(
                            library,
                            str(version or "*"),
                            "uv.lock",
                            path,
                            (import_name(library),),
                        )
                    )
            return pins, None
        project = document.get("project", {})
        requirements.extend(_strings(project.get("dependencies")))
        for group in (project.get("optional-dependencies") or {}).values():
            requirements.extend(_strings(group))
        for group in (document.get("dependency-groups") or {}).values():
            requirements.extend(_strings(group))
        source = "pyproject.toml"
    else:
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if line and not line.startswith("-"):
                requirements.append(line)
        source = "requirements"
    for requirement in requirements:
        parsed = _specifier(requirement)
        if parsed is not None:
            library = normalise(parsed[0])
            pins.append(Pin(library, parsed[1], source, path, (import_name(library),)))
    return pins, None


def _strings(value: object) -> list[str]:
    return (
        [item for item in value if isinstance(item, str)]
        if isinstance(value, list)
        else []
    )


@dataclass
class Module:
    path: str
    name: str
    is_package: bool
    version: str | None  # a literal ``__version__``
    version_from: list[str]  # modules ``__version__`` is imported from
    imports: list[tuple[str, int]]  # (absolute module name, line) of each import


def module_facts(entry: TreeEntry, name: str, tree: ast.Module) -> Module:
    is_package = entry.path.endswith("__init__.py")
    version, version_from, imports = None, [], []
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "__version__"
                for target in node.targets
            )
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            version = node.value.value
        if isinstance(node, ast.ImportFrom) and any(
            alias.name == "__version__" and alias.asname in (None, "__version__")
            for alias in node.names
        ):
            source = resolve_relative(name, is_package, node.module or "", node.level)
            if source is not None:
                version_from.append(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend((alias.name, node.lineno) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            source = resolve_relative(name, is_package, node.module or "", node.level)
            if source is None:
                continue
            imports.append((source, node.lineno))
            # ``from pkg import mod`` may import the submodule ``pkg.mod``.
            imports.extend(
                (f"{source}.{alias.name}", node.lineno) for alias in node.names
            )
    return Module(entry.path, name, is_package, version, version_from, imports)


@dataclass
class Tree:
    entries: dict[str, str]
    modules: dict[str, Module]
    pins: dict[tuple[str, str, str], Pin]  # (source, path, library) -> pin
    errors: list[dict]
    scope_map: ScopeMap
    scope_error: str | None

    def version_of(self, module: str) -> tuple[str, str] | None:
        """The ``__version__`` a module states or imports, with the module whose literal it is."""
        seen = set()
        for _ in range(MAX_VERSION_HOPS):
            facts = self.modules.get(module)
            if facts is None or module in seen:
                return None
            seen.add(module)
            if facts.version is not None:
                return facts.version, module
            if not facts.version_from:
                return None
            module = facts.version_from[-1]
        return None


def _is_manifest(path: str) -> bool:
    name = posixpath.basename(path)
    return name in ("pyproject.toml", "uv.lock") or REQUIREMENTS.match(name) is not None


def load_tree(repo: GitRepo, sha: str, cache: dict, limits: Limits) -> Tree:
    """Read one commit's modules and manifests. ``cache`` maps blob IDs to what they hold."""
    listed, errors = repo.tree(sha)
    entries = {entry.path: entry.oid for entry in listed}
    python = [entry for entry in listed if module_name(entry.path) is not None]
    if len(python) > limits.max_files:
        errors.append(
            _error(
                "too-many-files",
                "",
                f"{len(python)} Python files exceeds {limits.max_files}",
            )
        )
        python = python[: limits.max_files]
    read = [*python, *(entry for entry in listed if _is_manifest(entry.path))]
    for entry in read:
        if entry.size > limits.max_file_bytes:
            errors.append(
                _error(
                    "too-large",
                    entry.path,
                    f"{entry.size} bytes exceeds the limit of {limits.max_file_bytes}",
                )
            )
    wanted = {
        entry.oid
        for entry in read
        if entry.size <= limits.max_file_bytes and entry.oid not in cache
    }
    scopes_oid = entries.get(SCOPES_FILE)
    blobs = repo.blobs(sorted(wanted | ({scopes_oid} if scopes_oid else set())))
    cache.update((oid, blobs[oid]) for oid in wanted)

    modules: dict[str, Module] = {}
    pins: dict[tuple[str, str, str], Pin] = {}
    for entry in read:
        if entry.size > limits.max_file_bytes:
            continue
        data = cache[entry.oid]
        if _is_manifest(entry.path):
            found, error = manifest_pins(entry.path, data)
            if error is not None:
                errors.append(_error("manifest", entry.path, error))
            pins.update(((pin.source, pin.path, pin.name), pin) for pin in found)
            continue
        name = module_name(entry.path)
        try:
            modules[name] = module_facts(entry, name, parse_source(data, limits))
        except ParseError as error:
            errors.append(_error(error.kind, entry.path, str(error)))
    scope_map, scope_error = parse_scope_map(
        blobs.get(scopes_oid) if scopes_oid else None
    )
    tree = Tree(entries, modules, pins, errors, scope_map, scope_error)
    for name, facts in modules.items():
        version = tree.version_of(name)
        if version is not None:
            pins[("vendored", facts.path, name)] = Pin(
                name, version[0], "vendored", facts.path, (name,), version[1]
            )
    return tree


def version_changes(base: Tree, head: Tree) -> list[dict]:
    """Each library whose stated version differs, or that is added or removed, between the trees."""
    changes = []
    for key in sorted(base.pins.keys() | head.pins.keys()):
        before, after = base.pins.get(key), head.pins.get(key)
        if before is not None and after is not None and before.version == after.version:
            continue
        # A vendored module only on one side is new or deleted code, not a version change.
        if key[0] == "vendored" and (before is None or after is None):
            continue
        pin = after or before
        changes.append(
            {
                "library": pin.name,
                "source": pin.source,
                "path": pin.path,
                "before": before.version if before else None,
                "after": after.version if after else None,
                "modules": list(pin.modules),
                **(
                    {"origin": {"before": before.origin, "after": after.origin}}
                    if pin.source == "vendored"
                    else {}
                ),
            }
        )
    return changes


def find_uses(
    tree: Tree,
    scope_map: ScopeMap,
    changes: list[dict],
    scope_ids: set[str] | None,
    skip: set[str],
) -> list[dict]:
    """Each import of a changed library's modules in the tree, limited to the given scopes."""
    wanted = {
        module: change["library"] for change in changes for module in change["modules"]
    }
    uses = []
    for module in sorted(tree.modules.values(), key=lambda facts: facts.path):
        if module.path in skip:
            continue
        if scope_ids is not None and scope_map.scope_of(module.path) not in scope_ids:
            continue
        seen = set()
        for imported, line in module.imports:
            for target, library in wanted.items():
                if (
                    imported == target or imported.startswith(target + ".")
                ) and module.name != target:
                    key = (library, line)
                    if key not in seen:
                        seen.add(key)
                        uses.append(
                            {
                                "path": module.path,
                                "line": line,
                                "library": library,
                                "module": imported,
                            }
                        )
    return uses


def analyse(repo: GitRepo, request, limits: Limits = DEFAULT_LIMITS) -> dict:
    cache: dict = {}
    base = load_tree(repo, request.base, cache, limits)
    head = load_tree(repo, request.head, cache, limits)
    changes = version_changes(base, head)
    changed_paths = {
        path
        for path in base.entries.keys() | head.entries.keys()
        if base.entries.get(path) != head.entries.get(path)
    }
    forks = []
    for fork in request.forks:
        tree = load_tree(repo, fork.sha, cache, limits)
        scope_ids = set(fork.scopes) if fork.scopes else None
        # A fork searched as a whole tree (main) holds the change itself; its files are not uses.
        skip = changed_paths if scope_ids is None else set()
        forks.append(
            {
                "id": fork.id,
                "sha": fork.sha,
                "scopes": list(fork.scopes),
                "uses": find_uses(tree, head.scope_map, changes, scope_ids, skip)[
                    : limits.max_items
                ],
            }
        )
    errors = [
        {**error, "tree": label}
        for label, tree in (("base", base), ("head", head))
        for error in tree.errors
        if not error["path"] or error["path"] in changed_paths
    ]
    if head.scope_error is not None:
        errors.append(
            {**_error("scopes", SCOPES_FILE, head.scope_error), "tree": "head"}
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "tool": TOOL,
        "commandId": COMMAND_ID,
        "base": request.base,
        "head": request.head,
        "changes": changes[: limits.max_items],
        "forks": forks,
        "errors": errors[: limits.max_items],
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
