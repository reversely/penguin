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

The expand step of a split contract change comes in a request of its own (PRD 0.5 section 4.2 step
2), with the same edits read the other way round: the feature's code already uses the new name, and
the codemod keeps the old one working beside it.

    {"expand": [{"kind": "rename", "from": "core.util.old", "to": "core.util.new"}, ...],
     "paths": ["core/util.py", ...]}

- ``rename`` writes ``old = new`` right after the definition of ``new``, at module level or inside
  its class.
- ``move`` writes ``from <new module> import <name> as <old name>`` into the old module, after its
  imports.
- ``rename-parameter`` turns the function into one that takes both keywords: the old keyword takes
  the new one's place with a sentinel default, the new keyword becomes keyword-only with the same
  default, and the body starts by forwarding the old keyword to the new one. Every existing call,
  positional or by keyword, keeps working.

Each edit writes only into the listed file whose module holds the old name. An edit that is already
in place changes nothing. An edit the codemod cannot write is listed under ``refused`` with the reason.

A merge plan's rewrite rules come in a request of their own (PRD 4.2 step 4):

    {"rules": [{"id": "display", "contract": "shared/money/__init__.py::display",
                "kind": "expression", "pattern": "money.display($x)",
                "replacement": "$x.display()", "imports": []}, ...],
     "contracts": {"shared/money/__init__.py": "<the module's source at the checkpoint>"},
     "paths": ["checkout/saved.py", ...]}

Each rule is compiled into LibCST matchers; nothing in it is run. A rule is refused, and listed with
the reason, when its pattern or replacement does not parse as a Python expression, when an expression
pattern names no use of its contract (it would rewrite code outside the contract), or when its
replacement names anything other than its placeholders, the contract's module and the rule's own
imports from that module or the standard library. See ``compile_rule``. The valid rules apply in the
order given; then each file's imports of a contract module that the rewrite left unused go, and each
import a replacement needs is added.

The script rewrites only the listed files, in place, inside WORKTREE: a throwaway worktree the bridge
made. A path that is absolute, not normalised, outside the tree, a symlink, under a symlinked
directory or not a ``.py`` file is refused and never opened. The code is parsed, never imported or
run. The report on standard output lists each file changed, each file left alone and each refusal.

Exit status 2 means the request was malformed; nothing was written.
"""

import argparse
import dataclasses
import json
import os
import re
import stat
import sys
from collections.abc import Callable
from pathlib import PurePosixPath

import libcst as cst
import libcst.matchers as m
from libcst.codemod import CodemodContext, VisitorBasedCodemodCommand
from libcst.codemod.commands.rename import RenameCommand
from libcst.metadata import MetadataWrapper, ParentNodeProvider, QualifiedNameProvider

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

RULE_FIELDS = {"id", "contract", "kind", "pattern", "replacement", "imports"}
RULE_KINDS = ("expression", "annotation")
MAX_RULES = 32
MAX_RULE_TEXT = 500
MAX_IMPORTS = 8
RULE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CONTRACT = re.compile(
    r"^(?P<path>[A-Za-z0-9_][A-Za-z0-9_./-]{0,511}\.py)::(?P<symbol>[A-Za-z_][A-Za-z0-9_]{0,127})$"
)
PLACEHOLDER = re.compile(r"\$([a-z_][a-z0-9_]{0,31})")
# A placeholder becomes this prefix plus its name, so the rule parses as Python.
SENTINEL = "__penguin_"
# A rule pass runs again until nothing changes, so a match nested in another one's placeholder is
# rewritten too; this bounds the rounds.
MAX_ROUNDS = 8


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


def check_rule(rule: object) -> dict:
    """Return the rule when its fields are well formed; raise RequestError otherwise."""
    if not isinstance(rule, dict) or set(rule) != RULE_FIELDS:
        raise RequestError(
            f"a rule is an object with exactly the fields {', '.join(sorted(RULE_FIELDS))}"
        )
    if not isinstance(rule["id"], str) or not RULE_ID.match(rule["id"]):
        raise RequestError("a rule id is lowercase words joined by '-'")
    if not isinstance(rule["contract"], str) or not CONTRACT.match(rule["contract"]):
        raise RequestError(f"rule {rule['id']}: the contract is not path::symbol")
    if rule["kind"] not in RULE_KINDS:
        raise RequestError(f"rule {rule['id']}: the kind is one of {list(RULE_KINDS)}")
    for key in ("pattern", "replacement"):
        value = rule[key]
        if not isinstance(value, str) or not 0 < len(value) <= MAX_RULE_TEXT:
            raise RequestError(
                f"rule {rule['id']}: the {key} is text of 1 to {MAX_RULE_TEXT} characters"
            )
    imports = rule["imports"]
    if not isinstance(imports, list) or len(imports) > MAX_IMPORTS:
        raise RequestError(f"rule {rule['id']}: imports lists at most {MAX_IMPORTS}")
    for item in imports:
        if (
            not isinstance(item, dict)
            or set(item) != {"module", "name"}
            or not isinstance(item["module"], str)
            or not DOTTED.match(item["module"])
            or not isinstance(item["name"], str)
            or not IDENTIFIER.match(item["name"])
        ):
            raise RequestError(
                f"rule {rule['id']}: an import is {{module, name}}, a dotted module and a name"
            )
    return rule


def read_request(text: str) -> dict:
    """Parse and check the request; raise RequestError when it is malformed.

    Returns ``{"edits": [...], "paths": [...]}`` or ``{"rules": [...], "contracts": {...},
    "paths": [...]}``.
    """
    try:
        request = json.loads(text)
    except json.JSONDecodeError as error:
        raise RequestError(f"the request is not JSON: {error}") from None
    if not isinstance(request, dict) or set(request) not in (
        {"edits", "paths"},
        {"expand", "paths"},
        {"rules", "contracts", "paths"},
    ):
        raise RequestError(
            "the request is an object with edits and paths, expand and paths, or rules, contracts and paths"
        )
    paths = request["paths"]
    if (
        not isinstance(paths, list)
        or len(paths) > MAX_PATHS
        or not all(isinstance(p, str) for p in paths)
    ):
        raise RequestError(f"paths must list at most {MAX_PATHS} strings")
    paths = list(dict.fromkeys(paths))
    for key in ("edits", "expand"):
        if key in request:
            edits = request[key]
            if not isinstance(edits, list) or not 0 < len(edits) <= MAX_EDITS:
                raise RequestError(f"{key} must list 1 to {MAX_EDITS} edits")
            return {key: [check_edit(edit) for edit in edits], "paths": paths}
    rules, contracts = request["rules"], request["contracts"]
    if not isinstance(rules, list) or not 0 < len(rules) <= MAX_RULES:
        raise RequestError(f"rules must list 1 to {MAX_RULES} rules")
    checked = [check_rule(rule) for rule in rules]
    if len({rule["id"] for rule in checked}) != len(checked):
        raise RequestError("two rules share an id")
    if (
        not isinstance(contracts, dict)
        or len(contracts) > MAX_RULES
        or not all(
            isinstance(path, str)
            and isinstance(source, str)
            and len(source) <= MAX_FILE_BYTES
            for path, source in contracts.items()
        )
    ):
        raise RequestError("contracts maps each contract's path to its source")
    return {"rules": checked, "contracts": contracts, "paths": paths}


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


# The expand step: aliases and forwarding functions beside the new names.

UNSET = "_PENGUIN_UNSET"
EXPAND_NOTE = "# Penguin's expand step keeps the old name while callers move."


class ExpandRefused(Exception):
    """An expand edit the codemod cannot write, with the reason."""


def _bound_names(statement: cst.CSTNode) -> list[str]:
    """The names one statement of a block defines, assigns or imports."""
    if isinstance(statement, (cst.FunctionDef, cst.ClassDef)):
        return [statement.name.value]
    names = []
    if isinstance(statement, cst.SimpleStatementLine):
        for item in statement.body:
            if isinstance(item, cst.Assign):
                names += [
                    t.target.value
                    for t in item.targets
                    if isinstance(t.target, cst.Name)
                ]
            elif isinstance(item, cst.AnnAssign) and isinstance(item.target, cst.Name):
                names.append(item.target.value)
            elif isinstance(item, (cst.Import, cst.ImportFrom)) and not isinstance(
                item.names, cst.ImportStar
            ):
                names += [
                    (alias.evaluated_alias or alias.evaluated_name).split(".")[0]
                    for alias in item.names
                ]
    return names


def _binds(statements: list, name: str) -> bool:
    return any(name in _bound_names(statement) for statement in statements)


def _in_block(
    module: cst.Module, parents: list[str], edit: Callable[[list], list]
) -> cst.Module:
    """Applies ``edit`` to the statements of the module, or of the class ``parents`` names in it."""

    def descend(statements: list, path: list[str]) -> list:
        if not path:
            return edit(list(statements))
        for index, statement in enumerate(statements):
            if isinstance(statement, cst.ClassDef) and statement.name.value == path[0]:
                body = statement.body
                if not isinstance(body, cst.IndentedBlock):
                    raise ExpandRefused(f"class {path[0]} has no indented body")
                updated = statement.with_changes(
                    body=body.with_changes(body=descend(list(body.body), path[1:]))
                )
                return [*statements[:index], updated, *statements[index + 1 :]]
        raise ExpandRefused(f"no class {path[0]} in the file")

    return module.with_changes(body=descend(list(module.body), parents))


def _is_docstring(statement: cst.CSTNode) -> bool:
    return (
        isinstance(statement, cst.SimpleStatementLine)
        and isinstance(statement.body[0], cst.Expr)
        and isinstance(
            statement.body[0].value, (cst.SimpleString, cst.ConcatenatedString)
        )
    )


def _after_imports(statements: list) -> int:
    """The index just past the module's docstring and its leading imports."""
    index = 0
    for statement in statements:
        imports = isinstance(statement, cst.SimpleStatementLine) and all(
            isinstance(item, (cst.Import, cst.ImportFrom)) for item in statement.body
        )
        if not imports and not (index == 0 and _is_docstring(statement)):
            break
        index += 1
    return index


def _noted(line: cst.SimpleStatementLine, blank_lines: int) -> cst.SimpleStatementLine:
    return line.with_changes(
        leading_lines=[cst.EmptyLine(indent=False)] * blank_lines
        + [cst.EmptyLine(comment=cst.Comment(EXPAND_NOTE))]
    )


def expand_rename(module: cst.Module, local_from: str, local_to: str) -> cst.Module:
    """``old = new`` right after the definition of ``new``, in the same block."""
    *parents, old = local_from.split(".")
    *to_parents, new = local_to.split(".")
    if parents != to_parents:
        raise ExpandRefused("a rename keeps its module and class")

    def edit(statements: list) -> list:
        if _binds(statements, old):
            return statements
        for index, statement in enumerate(statements):
            if (
                isinstance(statement, (cst.FunctionDef, cst.ClassDef))
                and statement.name.value == new
            ):
                line = _noted(
                    cst.parse_statement(f"{old} = {new}\n"), 1 if parents else 2
                )
                return [*statements[: index + 1], line, *statements[index + 1 :]]
        raise ExpandRefused(f"no definition of {new} in the file")

    return _in_block(module, parents, edit)


def expand_move(module: cst.Module, old: str, to: str) -> cst.Module:
    """``from <new module> import <name> as <old>`` after the old module's imports."""
    if "." in old:
        raise ExpandRefused("only a module-level name moves by import")
    new_module, _, name = to.rpartition(".")
    statements = list(module.body)
    if _binds(statements, old):
        return module
    line = cst.parse_statement(f"from {new_module} import {name} as {old}\n")
    index = _after_imports(statements)
    return module.with_changes(body=[*statements[:index], line, *statements[index:]])


def _with_unset(module: cst.Module) -> cst.Module:
    """Adds ``import typing`` and the module's sentinel after its imports, unless present."""
    statements = list(module.body)
    if _binds(statements, UNSET):
        return module
    index = _after_imports(statements)
    added = (
        [] if _binds(statements, "typing") else [cst.parse_statement("import typing\n")]
    )
    added.append(_noted(cst.parse_statement(f"{UNSET}: typing.Any = object()\n"), 1))
    return module.with_changes(body=[*statements[:index], *added, *statements[index:]])


def _forwarding(
    module: cst.Module, function: cst.FunctionDef, old: str, new: str
) -> cst.FunctionDef:
    """``function`` taking keyword ``old`` in ``new``'s place, forwarding it to ``new``."""
    params = function.params
    if old in [param.name.value for param in (*params.params, *params.kwonly_params)]:
        return function
    unset = cst.Name(UNSET)
    positional = [param.name.value for param in params.params]
    keyword_only = [param.name.value for param in params.kwonly_params]
    tight = cst.AssignEqual(
        whitespace_before=cst.SimpleWhitespace(""),
        whitespace_after=cst.SimpleWhitespace(""),
    )

    def unset_default(param: cst.Param, name: str) -> cst.Param:
        # PEP 8 spacing: `x=default`, but `x: int = default` with an annotation.
        equal = cst.MaybeSentinel.DEFAULT if param.annotation is not None else tight
        return param.with_changes(
            name=cst.Name(name),
            default=unset,
            equal=equal,
            comma=cst.MaybeSentinel.DEFAULT,
        )

    if new in positional:
        index = positional.index(new)
        original = params.params[index]
        if any(param.default is None for param in params.params[index + 1 :]):
            raise ExpandRefused(
                f"a positional parameter after {new} has no default, so {old} cannot take its place"
            )
        star = params.star_arg
        updated = params.with_changes(
            params=[
                *params.params[:index],
                unset_default(original, old),
                *params.params[index + 1 :],
            ],
            kwonly_params=[*params.kwonly_params, unset_default(original, new)],
            star_arg=cst.ParamStar() if isinstance(star, cst.MaybeSentinel) else star,
        )
    elif new in keyword_only:
        index = keyword_only.index(new)
        original = params.kwonly_params[index]
        updated = params.with_changes(
            kwonly_params=[
                *params.kwonly_params[:index],
                unset_default(original, old),
                *params.kwonly_params[index + 1 :],
                unset_default(original, new),
            ]
        )
    else:
        raise ExpandRefused(f"{new} is not a parameter a caller can pass by keyword")
    name = function.name.value
    missing = (
        f"    raise TypeError({f'{name}() missing required argument {new!r}'!r})\n"
        if original.default is None
        else f"    {new} = {module.code_for_node(original.default)}\n"
    )
    prologue = cst.parse_statement(
        f"if {old} is not {UNSET}:\n"
        f"    if {new} is not {UNSET}:\n"
        f"        raise TypeError({f'{name}() got both {old!r} and {new!r}'!r})\n"
        f"    {new} = {old}\n"
        f"elif {new} is {UNSET}:\n{missing}"
    )
    body = function.body
    if not isinstance(body, cst.IndentedBlock):
        raise ExpandRefused(f"{name} has no indented body")
    statements = list(body.body)
    at = 1 if statements and _is_docstring(statements[0]) else 0
    return function.with_changes(
        params=updated,
        body=body.with_changes(body=[*statements[:at], prologue, *statements[at:]]),
    )


def expand_keyword(module: cst.Module, local: str, old: str, new: str) -> cst.Module:
    """The function ``local`` names taking keyword ``old`` beside ``new``, with the module's sentinel."""
    *parents, name = local.split(".")

    def edit(statements: list) -> list:
        for index, statement in enumerate(statements):
            if isinstance(statement, cst.FunctionDef) and statement.name.value == name:
                updated = _forwarding(module, statement, old, new)
                return [*statements[:index], updated, *statements[index + 1 :]]
        raise ExpandRefused(f"no function {name} in the file")

    before = module.code
    module = _in_block(module, parents, edit)
    return module if module.code == before else _with_unset(module)


def apply_expand(
    source: str, path: str, edits: list[dict], refused: list[dict]
) -> tuple[str, list[int]]:
    """The source with each expand edit whose old name lives in this file written, and their indexes."""
    module = cst.parse_module(source)
    own = module_name(path)
    applied = []
    for index, edit in enumerate(edits):
        dotted = (
            edit["function"] if edit["kind"] == "rename-parameter" else edit["from"]
        )
        if not dotted.startswith(f"{own}."):
            continue
        local = dotted[len(own) + 1 :]
        before = module.code
        try:
            if edit["kind"] == "rename":
                if not edit["to"].startswith(f"{own}."):
                    raise ExpandRefused("a rename keeps its module")
                module = expand_rename(module, local, edit["to"][len(own) + 1 :])
            elif edit["kind"] == "move":
                module = expand_move(module, local, edit["to"])
            else:
                module = expand_keyword(module, local, edit["from"], edit["to"])
        except ExpandRefused as error:
            refused.append({"edit": index, "path": path, "message": str(error)})
            continue
        if module.code != before:
            applied.append(index)
    return module.code, applied


class RuleRefused(Exception):
    """A rule that may not be applied, with the reason."""


def dotted(node: cst.CSTNode) -> str | None:
    """The dotted name a Name or a chain of Attributes spells, such as ``money.display``."""
    if isinstance(node, cst.Name):
        return node.value
    if isinstance(node, cst.Attribute):
        base = dotted(node.value)
        return None if base is None else f"{base}.{node.attr.value}"
    return None


def parse_template(text: str, what: str) -> tuple[cst.BaseExpression, list[str]]:
    """A rule's pattern or replacement parsed as an expression, and its placeholders in order."""
    if SENTINEL in text:
        raise RuleRefused(f"the {what} may not spell {SENTINEL}")
    if "$" in PLACEHOLDER.sub("", text):
        raise RuleRefused(f"the {what} has a $ that starts no placeholder")
    names = PLACEHOLDER.findall(text)
    try:
        node = cst.parse_expression(
            PLACEHOLDER.sub(lambda found: SENTINEL + found.group(1), text)
        )
    except cst.ParserSyntaxError:
        raise RuleRefused(f"the {what} does not parse as a Python expression") from None
    return node, names


def provided_names(source: str) -> tuple[set[str], set[str]]:
    """The module's top-level names, and the names its classes define."""
    module = cst.parse_module(source)
    top: set[str] = set()
    members: set[str] = set()

    def targets(statement: cst.BaseSmallStatement) -> list[str]:
        if isinstance(statement, cst.AnnAssign):
            return [dotted(statement.target) or ""]
        if isinstance(statement, cst.Assign):
            return [dotted(target.target) or "" for target in statement.targets]
        if isinstance(statement, (cst.Import, cst.ImportFrom)) and not isinstance(
            statement.names, cst.ImportStar
        ):
            return [
                alias.asname.name.value
                if alias.asname is not None and isinstance(alias.asname.name, cst.Name)
                else dotted(alias.name) or ""
                for alias in statement.names
            ]
        return []

    for statement in module.body:
        if isinstance(statement, (cst.FunctionDef, cst.ClassDef)):
            top.add(statement.name.value)
        if isinstance(statement, cst.SimpleStatementLine):
            for small in statement.body:
                top.update(targets(small))
        if isinstance(statement, cst.ClassDef):
            for inner in statement.body.body:
                if isinstance(inner, (cst.FunctionDef, cst.ClassDef)):
                    members.add(inner.name.value)
                if isinstance(inner, cst.SimpleStatementLine):
                    for small in inner.body:
                        members.update(targets(small))
    return top - {""}, members - {""}


def placeholder_of(node: cst.CSTNode) -> str | None:
    """The placeholder a sentinel Name stands for, or None."""
    if isinstance(node, cst.Name) and node.value.startswith(SENTINEL):
        return node.value[len(SENTINEL) :]
    return None


# Nodes that bind names or defer code; a replacement holds none of them.
BINDING_NODES = (
    cst.Lambda,
    cst.ListComp,
    cst.SetComp,
    cst.DictComp,
    cst.GeneratorExp,
    cst.NamedExpr,
    cst.Await,
    cst.Yield,
)
# Expressions that need no parentheses wherever they stand.
ATOMIC_NODES = (
    cst.Name,
    cst.Attribute,
    cst.Call,
    cst.Subscript,
    cst.Integer,
    cst.Float,
    cst.Imaginary,
    cst.SimpleString,
    cst.ConcatenatedString,
    cst.FormattedString,
    cst.List,
    cst.Set,
    cst.Dict,
    cst.Ellipsis,
)
# Parents under which any expression may stand without parentheses.
SAFE_PARENTS = (
    cst.Arg,
    cst.Element,
    cst.DictElement,
    cst.Return,
    cst.Assign,
    cst.AnnAssign,
    cst.AugAssign,
    cst.Expr,
    cst.FormattedStringExpression,
    cst.Index,
    cst.Annotation,
)
FORMAT_FIELDS = {"lpar", "rpar", "comma", "dot", "equal"}
WHITESPACE_NODES = (
    cst.BaseParenthesizableWhitespace,
    cst.Newline,
    cst.EmptyLine,
    cst.TrailingWhitespace,
    cst.Comment,
)


def atomic(node: cst.BaseExpression) -> bool:
    return isinstance(node, ATOMIC_NODES) or bool(getattr(node, "lpar", ()))


def parenthesized(node: cst.BaseExpression) -> cst.BaseExpression:
    if atomic(node):
        return node
    return node.with_changes(lpar=[cst.LeftParen()], rpar=[cst.RightParen()])


def bare(node: cst.BaseExpression) -> cst.BaseExpression:
    """The node without its own parentheses."""
    if getattr(node, "lpar", ()):
        return node.with_changes(lpar=[], rpar=[])
    return node


@dataclasses.dataclass
class Rule:
    """A rule compiled into LibCST matchers, ready to apply."""

    id: str
    kind: str
    module: str
    alias: str
    symbol: str
    qualified: str
    pattern: cst.BaseExpression
    replacement: cst.BaseExpression
    imports: dict[str, str]
    matcher: m.BaseMatcherNode

    def module_name_of(self, chain: str) -> str | None:
        """The qualified name a pattern's dotted name stands for in the contract's module, or None."""
        if chain == self.symbol:
            return self.qualified
        for root in (self.alias, self.module):
            if chain.startswith(f"{root}."):
                return f"{self.module}.{chain[len(root) + 1 :]}"
        return None


def compile_rule(rule: dict, contracts: dict[str, str]) -> Rule:
    """Check one rule and compile its pattern into matchers; raise RuleRefused when it may not apply."""
    found = CONTRACT.match(rule["contract"])
    assert found is not None  # check_rule matched it already
    path, symbol = found.group("path"), found.group("symbol")
    module = module_name(path)
    alias = module.rsplit(".", 1)[-1]
    source = contracts.get(path)
    if source is None:
        raise RuleRefused(f"{path} is not in the checkpoint")
    try:
        top, members = provided_names(source)
    except cst.ParserSyntaxError:
        raise RuleRefused(f"{path} does not parse at the checkpoint") from None
    pattern, pattern_names = parse_template(rule["pattern"], "pattern")
    replacement, replacement_names = parse_template(rule["replacement"], "replacement")
    if len(set(pattern_names)) != len(pattern_names):
        raise RuleRefused("a placeholder appears twice in the pattern")
    missing = sorted(set(replacement_names) - set(pattern_names))
    if missing:
        raise RuleRefused(
            f"the replacement uses ${missing[0]}, which the pattern does not bind"
        )
    imports = {}
    for item in rule["imports"]:
        root = item["module"].split(".", 1)[0]
        if item["module"] != module and root not in sys.stdlib_module_names:
            raise RuleRefused(
                f"an import comes from {module} or the standard library, not {item['module']}"
            )
        if item["module"] == module and item["name"] not in top:
            raise RuleRefused(f"{module} does not define {item['name']}")
        if item["name"] == alias:
            raise RuleRefused(f"an import may not be named {alias}")
        imports[item["name"]] = item["module"]
    compiled = Rule(
        id=rule["id"],
        kind=rule["kind"],
        module=module,
        alias=alias,
        symbol=symbol,
        qualified=f"{module}.{symbol}",
        pattern=pattern,
        replacement=replacement,
        imports=imports,
        matcher=m.DoNotCare(),
    )
    if rule["kind"] == "expression":
        uses = [
            chain
            for chain in chains(pattern)
            if compiled.module_name_of(chain) == compiled.qualified
        ]
        if not uses:
            raise RuleRefused(
                f"the pattern names no use of {compiled.qualified}, so it would rewrite code "
                "outside its contract"
            )
    elif pattern_names or replacement_names:
        raise RuleRefused("an annotation rule takes no placeholders")
    check_replacement(compiled, top, members)
    compiled.matcher = matcher_for(pattern, compiled)
    return compiled


def chains(node: cst.CSTNode) -> list[str]:
    """Each whole dotted name in an expression: ``money.display`` but not its ``money``."""
    found: list[str] = []

    def walk(current: cst.CSTNode) -> None:
        chain = dotted(current)
        if chain is not None:
            found.append(chain)
            return
        for child in current.children:
            walk(child)

    walk(node)
    return found


def check_replacement(rule: Rule, top: set[str], members: set[str]) -> None:
    """Refuse a replacement that names anything its contract's module and its imports do not provide."""

    def walk(node: cst.CSTNode) -> None:
        if isinstance(node, BINDING_NODES):
            raise RuleRefused(f"the replacement may not hold a {type(node).__name__}")
        if isinstance(node, cst.Attribute):
            chain = dotted(node)
            if chain is not None and chain.split(".", 1)[0] == rule.alias:
                segments = chain.split(".")
                if segments[1] not in top:
                    raise RuleRefused(f"{rule.module} does not define {segments[1]}")
                for name in segments[2:]:
                    if name not in members | top:
                        raise RuleRefused(
                            f"the replacement reaches .{name}, which {rule.module} does not define"
                        )
                return
            walk(node.value)
            if node.attr.value not in members | top:
                raise RuleRefused(
                    f"the replacement reaches .{node.attr.value}, which {rule.module} does not define"
                )
            return
        if isinstance(node, cst.Name):
            if placeholder_of(node) is None and node.value not in rule.imports:
                raise RuleRefused(
                    f"the replacement names {node.value}, which neither {rule.module} nor the "
                    "rule's imports provide"
                )
            return
        if isinstance(node, cst.Arg) and node.keyword is not None:
            walk(node.value)
            return
        for child in node.children:
            walk(child)

    walk(rule.replacement)


def matcher_for(node: cst.CSTNode, rule: Rule) -> m.BaseMatcherNode:
    """A LibCST matcher for a pattern node: formatting is ignored, placeholders match anything and
    a name in the contract's module matches any spelling that resolves to it."""
    name = placeholder_of(node)
    if name is not None:
        return m.SaveMatchedNode(m.DoNotCare(), name)
    chain = dotted(node)
    if chain is not None:
        qualified = rule.module_name_of(chain)
        if qualified is not None:
            resolved = m.MatchMetadataIfTrue(
                QualifiedNameProvider,
                lambda names, wanted=qualified: any(
                    each.name == wanted for each in names
                ),
            )
            reference = m.OneOf(
                m.Name(metadata=resolved), m.Attribute(metadata=resolved)
            )
            if qualified == rule.qualified:
                return m.SaveMatchedNode(reference, "__contract__")
            return reference
    fields = {}
    for field in dataclasses.fields(node):
        if field.name in FORMAT_FIELDS or field.name.startswith("whitespace"):
            continue
        fields[field.name] = matcher_value(getattr(node, field.name), rule)
    return getattr(m, type(node).__name__)(**fields)


def matcher_value(value: object, rule: Rule) -> object:
    if isinstance(value, (*WHITESPACE_NODES, cst.MaybeSentinel)):
        return m.DoNotCare()
    if isinstance(value, cst.CSTNode):
        return matcher_for(value, rule)
    if isinstance(value, (list, tuple)):
        return [matcher_value(item, rule) for item in value]
    return value


class Filler(cst.CSTTransformer):
    """Builds a replacement: each placeholder becomes the code it captured, parenthesised where it
    must be, and the contract's module is spelled the way the file reaches it."""

    def __init__(self, rule: Rule, captures: dict, alias: str | None) -> None:
        super().__init__()
        self.rule = rule
        self.captures = captures
        self.alias = alias
        self.inserted: set[int] = set()
        self.imports: set[tuple[str, str]] = set()

    def leave_Name(
        self, original_node: cst.Name, updated_node: cst.Name
    ) -> cst.BaseExpression:
        name = placeholder_of(original_node)
        if name is not None:
            captured = bare(self.captures[name].deep_clone())
            self.inserted.add(id(captured))
            return captured
        if original_node.value in self.rule.imports:
            self.imports.add(
                (self.rule.imports[original_node.value], original_node.value)
            )
        return updated_node

    def leave_Attribute(
        self, original_node: cst.Attribute, updated_node: cst.Attribute
    ) -> cst.BaseExpression:
        chain = dotted(original_node)
        if chain is not None and chain.split(".", 1)[0] == self.rule.alias:
            name = chain.split(".", 1)[1]
            if self.alias is not None:
                return cst.parse_expression(f"{self.alias}.{name}")
            self.imports.add((self.rule.module, name))
            return cst.Name(name)
        value = updated_node.value
        # `1.display()` would read as the float `1.` followed by a name.
        if id(value) in self.inserted and isinstance(
            value, (cst.Integer, cst.Float, cst.Imaginary)
        ):
            return updated_node.with_changes(
                value=value.with_changes(
                    lpar=[cst.LeftParen()], rpar=[cst.RightParen()]
                )
            )
        return updated_node.with_changes(value=self.wrap(value))

    def leave_Call(self, original_node: cst.Call, updated_node: cst.Call) -> cst.Call:
        return updated_node.with_changes(func=self.wrap(updated_node.func))

    def leave_Subscript(
        self, original_node: cst.Subscript, updated_node: cst.Subscript
    ) -> cst.Subscript:
        return updated_node.with_changes(value=self.wrap(updated_node.value))

    def leave_BinaryOperation(
        self, original_node: cst.BinaryOperation, updated_node: cst.BinaryOperation
    ) -> cst.BinaryOperation:
        return updated_node.with_changes(
            left=self.wrap(updated_node.left), right=self.wrap(updated_node.right)
        )

    def leave_UnaryOperation(
        self, original_node: cst.UnaryOperation, updated_node: cst.UnaryOperation
    ) -> cst.UnaryOperation:
        return updated_node.with_changes(expression=self.wrap(updated_node.expression))

    def leave_BooleanOperation(
        self, original_node: cst.BooleanOperation, updated_node: cst.BooleanOperation
    ) -> cst.BooleanOperation:
        return updated_node.with_changes(
            left=self.wrap(updated_node.left), right=self.wrap(updated_node.right)
        )

    def leave_Comparison(
        self, original_node: cst.Comparison, updated_node: cst.Comparison
    ) -> cst.Comparison:
        return updated_node.with_changes(
            left=self.wrap(updated_node.left),
            comparisons=[
                target.with_changes(comparator=self.wrap(target.comparator))
                for target in updated_node.comparisons
            ],
        )

    def wrap(self, node: cst.BaseExpression) -> cst.BaseExpression:
        return parenthesized(node) if id(node) in self.inserted else node


def fill(
    rule: Rule, captures: dict, alias: str | None
) -> tuple[cst.BaseExpression, set[tuple[str, str]]]:
    filler = Filler(rule, captures, alias)
    built = rule.replacement.visit(filler)
    assert isinstance(built, cst.BaseExpression)
    return bare(built), filler.imports


def module_alias(reference: cst.CSTNode | None) -> str | None:
    """How the file reaches the contract's module: the code before ``.symbol``, or None."""
    if isinstance(reference, cst.Attribute):
        return cst.Module(body=[]).code_for_node(reference.value)
    return None


class RulePass(VisitorBasedCodemodCommand):
    """One round of a list of rules over a module. At each expression the first rule in the list whose
    pattern matches applies. Imports the replacements need are collected, not added here."""

    METADATA_DEPENDENCIES = (QualifiedNameProvider, ParentNodeProvider)

    def __init__(self, context: CodemodContext, rules: list[Rule]) -> None:
        super().__init__(context)
        self.expression = [rule for rule in rules if rule.kind == "expression"]
        self.annotation = [rule for rule in rules if rule.kind == "annotation"]
        self.applied: set[str] = set()
        self.imports: set[tuple[str, str]] = set()

    def calls_of(self, rule: Rule, node: cst.CSTNode) -> bool:
        names = self.get_metadata(QualifiedNameProvider, node, set())
        return any(each.name == rule.qualified for each in names)

    def on_leave(self, original_node: cst.CSTNode, updated_node: cst.CSTNode) -> object:
        updated = super().on_leave(original_node, updated_node)
        if not isinstance(original_node, cst.BaseExpression):
            return updated
        for rule in self.expression:
            captures = m.extract(original_node, rule.matcher, metadata_resolver=self)
            if captures is None:
                continue
            built, imports = fill(
                rule, captures, module_alias(captures.get("__contract__"))
            )
            parent = self.get_metadata(ParentNodeProvider, original_node, None)
            if original_node.lpar:
                built = built.with_changes(
                    lpar=original_node.lpar, rpar=original_node.rpar
                )
            elif not isinstance(parent, SAFE_PARENTS):
                built = parenthesized(built)
            self.applied.add(rule.id)
            self.imports |= imports
            return built
        return updated

    def leave_FunctionDef(
        self, original_node: cst.FunctionDef, updated_node: cst.FunctionDef
    ) -> cst.FunctionDef:
        """Annotation rules: the return annotation is rewritten when every return is a call of the
        rule's contract, and each parameter passed by name to a call of the contract."""
        if not self.annotation:
            return updated_node
        all_calls, returns = calls_and_returns(original_node.body)
        returns_done = False
        params_done: set[str] = set()
        result = updated_node
        for rule in self.annotation:
            calls = [call for call in all_calls if self.calls_of(rule, call.func)]
            if not calls:
                continue
            contract_returns = [
                value
                for value in returns
                if isinstance(value, cst.Call) and self.calls_of(rule, value.func)
            ]
            if (
                not returns_done
                and original_node.returns is not None
                and returns
                and len(contract_returns) == len(returns)
                and m.matches(original_node.returns.annotation, rule.matcher)
            ):
                built, imports = fill(rule, {}, module_alias(contract_returns[0].func))
                result = result.with_changes(
                    returns=result.returns.with_changes(annotation=built)
                )
                returns_done = True
                self.applied.add(rule.id)
                self.imports |= imports
            passed = {
                arg.value.value
                for call in calls
                for arg in call.args
                if isinstance(arg.value, cst.Name)
            }
            alias = module_alias(calls[0].func)

            def annotated(
                param: cst.Param,
                rule: Rule = rule,
                passed: set = passed,
                alias: str | None = alias,
            ) -> cst.Param:
                name = param.name.value
                if (
                    name in params_done
                    or name not in passed
                    or param.annotation is None
                    or not m.matches(param.annotation.annotation, rule.matcher)
                ):
                    return param
                built, imports = fill(rule, {}, alias)
                params_done.add(name)
                self.applied.add(rule.id)
                self.imports |= imports
                return param.with_changes(
                    annotation=param.annotation.with_changes(annotation=built)
                )

            result = result.with_changes(
                params=result.params.with_changes(
                    params=[annotated(param) for param in result.params.params],
                    kwonly_params=[
                        annotated(param) for param in result.params.kwonly_params
                    ],
                    posonly_params=[
                        annotated(param) for param in result.params.posonly_params
                    ],
                )
            )
        return result


def calls_and_returns(
    body: cst.BaseSuite,
) -> tuple[list[cst.Call], list[cst.BaseExpression | None]]:
    """The calls and the returned values of one function body, outside nested functions and classes."""
    calls: list[cst.Call] = []
    returns: list[cst.BaseExpression | None] = []

    class Collect(cst.CSTVisitor):
        def visit_FunctionDef(self, node: cst.FunctionDef) -> bool:
            return False

        def visit_ClassDef(self, node: cst.ClassDef) -> bool:
            return False

        def visit_Lambda(self, node: cst.Lambda) -> bool:
            return False

        def visit_Call(self, node: cst.Call) -> None:
            calls.append(node)

        def visit_Return(self, node: cst.Return) -> None:
            returns.append(node.value)

    body.visit(Collect())
    return calls, returns


class ImportCleanup(VisitorBasedCodemodCommand):
    """Adds the imports the replacements need and removes each import of a contract's module or of
    one of its names that the rewrite left unused."""

    def __init__(
        self, context: CodemodContext, modules: set[str], needed: set[tuple[str, str]]
    ) -> None:
        super().__init__(context)
        self.modules = modules
        for module, name in sorted(needed):
            self.add_needed_import(module, name)

    def visit_ImportFrom(self, node: cst.ImportFrom) -> None:
        if (
            node.relative
            or node.module is None
            or isinstance(node.names, cst.ImportStar)
        ):
            return
        module = dotted(node.module)
        for alias in node.names:
            name = dotted(alias.name)
            if module in self.modules or f"{module}.{name}" in self.modules:
                asname = (
                    alias.asname.name.value
                    if alias.asname is not None
                    and isinstance(alias.asname.name, cst.Name)
                    else None
                )
                self.remove_unused_import(module, name, asname)

    def visit_Import(self, node: cst.Import) -> None:
        for alias in node.names:
            module = dotted(alias.name)
            if module in self.modules:
                asname = (
                    alias.asname.name.value
                    if alias.asname is not None
                    and isinstance(alias.asname.name, cst.Name)
                    else None
                )
                self.remove_unused_import(module, None, asname)


def apply_rules(source: str, path: str, rules: list[Rule]) -> tuple[str, list[str]]:
    """The rewritten source and the ids of the rules that changed it, in the rules' order."""
    # Any use of a contract spells its symbol somewhere in the file, if only in the import.
    relevant = [rule for rule in rules if rule.symbol in source]
    if not relevant:
        return source, []
    module = cst.parse_module(source)
    full_name = module_name(path)
    applied: set[str] = set()
    needed: set[tuple[str, str]] = set()
    # Annotation rules read each function as it was, before any expression rule rewrote its calls.
    # Expression rules then run in rounds, so a match inside another match's placeholder is rewritten too.
    passes = [[rule for rule in relevant if rule.kind == "annotation"]] + [
        [rule for rule in relevant if rule.kind == "expression"]
    ] * MAX_ROUNDS
    for round_rules in passes:
        if not round_rules:
            continue
        rewrite = RulePass(
            CodemodContext(filename=path, full_module_name=full_name), round_rules
        )
        module = rewrite.transform_module(module)
        applied |= rewrite.applied
        needed |= rewrite.imports
        if not rewrite.applied and round_rules[0].kind == "expression":
            break
    if not applied:
        return source, []
    cleanup = ImportCleanup(
        CodemodContext(filename=path, full_module_name=full_name),
        {rule.module for rule in relevant if rule.id in applied},
        needed,
    )
    return cleanup.transform_module(module).code, [
        rule.id for rule in rules if rule.id in applied
    ]


def compile_rules(
    rules: list[dict], contracts: dict[str, str]
) -> tuple[list[Rule], list[dict]]:
    """The rules that may apply, and each refused one with its reason."""
    compiled, refused = [], []
    for rule in rules:
        try:
            compiled.append(compile_rule(rule, contracts))
        except RuleRefused as error:
            refused.append({"rule": rule["id"], "message": str(error)})
    return compiled, refused


def run(
    tree: str,
    transform: Callable[[str, str], tuple[str, list]],
    paths: list[str],
) -> dict:
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
            rewritten, applied = transform(source, path)
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
        changed.append({"path": path, "applied": applied})
    return {"changed": changed, "unchanged": unchanged, "errors": errors}


def report(request: dict, tree: str) -> dict:
    """Applies the request's edits or rules to its paths and reports what changed."""
    head = {"schemaVersion": SCHEMA_VERSION, "commandId": "fix:python-codemod"}
    if "edits" in request:
        edits = request["edits"]
        result = run(
            tree,
            lambda source, path: apply_edits(source, path, edits),
            request["paths"],
        )
        for entry in result["changed"]:
            entry["edits"] = entry.pop("applied")
        return {**head, "edits": edits, **result}
    if "expand" in request:
        edits, refused = request["expand"], []
        result = run(
            tree,
            lambda source, path: apply_expand(source, path, edits, refused),
            request["paths"],
        )
        for entry in result["changed"]:
            entry["edits"] = entry.pop("applied")
        return {**head, "expand": edits, "refused": refused, **result}
    rules, refused = compile_rules(request["rules"], request["contracts"])
    if rules:
        result = run(
            tree,
            lambda source, path: apply_rules(source, path, rules),
            request["paths"],
        )
    else:
        result = {"changed": [], "unchanged": list(request["paths"]), "errors": []}
    for entry in result["changed"]:
        entry["rules"] = entry.pop("applied")
    return {**head, "rules": [rule.id for rule in rules], "refused": refused, **result}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Penguin's codemod for mechanical interface changes"
    )
    parser.add_argument("--tree", required=True)
    args = parser.parse_args()
    try:
        request = read_request(sys.stdin.read())
    except RequestError as error:
        print(f"python_codemod: {error}", file=sys.stderr)
        return 2
    if not os.path.isdir(args.tree):
        print("python_codemod: --tree is not a directory", file=sys.stderr)
        return 2
    json.dump(report(request, args.tree), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
