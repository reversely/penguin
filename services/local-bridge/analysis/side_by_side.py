"""Runs a scope's public functions on one checked-out tree, with inputs given as data.

Usage: python3 -I side_by_side.py --tree PATH < request.json

The request is a JSON object: ``{"contracts": [CONTRACT, ...], "calls": [{"id": ID, "contract":
CONTRACT, "args": {NAME: VALUE}}]}``. A contract is ``path::symbol`` from ``penguin/scopes.json``;
``contracts`` lists every contract an input may name; a declared class covers its methods. Each call's arguments are JSON, built into the
types the function's annotations name:

- ``str``, ``int``, ``float``, ``bool`` and ``None`` from the same JSON value; ``Literal`` values;
- lists, tuples, sets, iterables and sequences from a JSON array; dicts and mappings from an object;
- a dataclass from an object of its fields; an ``Enum`` from its value; ``X | None`` and unions by
  trying each member in turn; ``object``, ``Any`` and a missing annotation take the JSON value as is;
- any other type only from ``{"$call": CONTRACT, "args": {...}}``, which calls that declared contract
  with arguments built the same way, such as ``IdentityMap.from_events``.

Every call is first checked against its function's signature without building anything; a call that
does not fit is reported ``invalid`` with the reason and never run. The rest then run in order. The
report on standard output gives each call's encoded return value or the exception it raised, with
its time. The arguments are never evaluated as code: JSON values only become the declared types.

The tree's code runs in this process, as a test command's would; the bridge starts this script in
isolated mode with a scrubbed environment, a timeout and an output cap. Anything the code prints goes
to standard error, so only the report reaches standard output.
"""

import argparse
import dataclasses
import enum
import importlib
import inspect
import json
import math
import os
import re
import sys
import time
import types
import typing
from collections import abc

TOOL = "side-by-side"
MAX_REQUEST_BYTES = 8_000_000
MAX_CALLS = 10_000
MAX_DEPTH = 32
MAX_NODES = 200_000
MAX_CALL_NESTING = 4

CONTRACT = re.compile(
    r"^([A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\.py)::"
    r"([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$"
)
ARG_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")

SEQUENCES = {
    list,
    abc.Iterable,
    abc.Sequence,
    abc.Collection,
    abc.MutableSequence,
    abc.Iterator,
}
SETS = {set, frozenset, abc.Set, abc.MutableSet}
MAPPINGS = {dict, abc.Mapping, abc.MutableMapping}


def declared(contract: str, contracts: frozenset) -> bool:
    """Whether a contract is declared, or is a method of a declared class (``path::Class.method``)."""
    path, _, symbol = contract.partition("::")
    parts = symbol.split(".")
    return any(
        f"{path}::{'.'.join(parts[:n])}" in contracts for n in range(1, len(parts) + 1)
    )


class Invalid(Exception):
    """An input that does not fit the function's signature."""


class RequestError(Exception):
    """A request that breaks the format."""


def module_name(path: str) -> str:
    name = path[: -len(".py")].replace("/", ".")
    return name.removesuffix(".__init__")


def resolve(contract: str):
    """Imports a contract's module from the tree and returns the named object."""
    match = CONTRACT.match(contract)
    if match is None:
        raise Invalid(f"{contract} is not a Python contract path.py::symbol")
    try:
        target = importlib.import_module(module_name(match.group(1)))
    except Exception as error:  # noqa: BLE001 - the tree's code may raise anything on import
        raise Invalid(
            f"cannot import {match.group(1)}: {type(error).__name__}: {error}"
        ) from None
    for name in match.group(2).split("."):
        if name.startswith("__") or not hasattr(target, name):
            raise Invalid(f"{contract} names nothing in the tree")
        target = getattr(target, name)
    if not callable(target):
        raise Invalid(f"{contract} is not callable")
    return target


def hints_of(target) -> dict:
    """The parameter annotations of a callable; an unresolvable one counts as missing."""
    function = (
        target.__init__
        if inspect.isclass(target)
        else getattr(target, "__func__", target)
    )
    try:
        return typing.get_type_hints(function)
    except Exception:  # noqa: BLE001 - an annotation the tree cannot resolve counts as missing
        raw = getattr(function, "__annotations__", {}) or {}
        return {name: hint for name, hint in raw.items() if not isinstance(hint, str)}


def signature_of(target) -> inspect.Signature:
    try:
        return inspect.signature(target)
    except (TypeError, ValueError):
        raise Invalid("the function has no signature to check inputs against") from None


class Builder:
    """Turns JSON values into annotated types; with ``build`` false it only checks them."""

    def __init__(self, contracts: frozenset, build: bool):
        self.contracts = contracts
        self.build = build

    def call(self, contract: str, args, nesting: int = 0):
        if not declared(contract, self.contracts):
            raise Invalid(f"{contract} is not a declared contract")
        if nesting > MAX_CALL_NESTING:
            raise Invalid(f"$call nests deeper than {MAX_CALL_NESTING}")
        if not isinstance(args, dict) or not all(
            isinstance(k, str) and ARG_NAME.match(k) for k in args
        ):
            raise Invalid(
                f"the args of {contract} must be an object of parameter names"
            )
        target = resolve(contract)
        signature = signature_of(target)
        for parameter in signature.parameters.values():
            if parameter.kind is parameter.POSITIONAL_ONLY:
                raise Invalid(
                    f"{contract} takes positional-only parameters, which inputs cannot name"
                )
        try:
            signature.bind(**args)
        except TypeError as error:
            raise Invalid(f"{contract}: {error}") from None
        hints = hints_of(target)
        built = {}
        for name, value in args.items():
            annotation = hints.get(name, signature.parameters[name].annotation)
            try:
                built[name] = self.value(value, annotation, 0, nesting)
            except Invalid as error:
                raise Invalid(f"{contract} argument {name}: {error}") from None
        return (target, built)

    def value(self, value, annotation, depth: int, nesting: int):
        if depth > MAX_DEPTH:
            raise Invalid(f"the value nests deeper than {MAX_DEPTH}")
        if (
            isinstance(value, dict)
            and set(value) == {"$call", "args"}
            and isinstance(value["$call"], str)
        ):
            target, built = self.call(value["$call"], value["args"], nesting + 1)
            return target(**built) if self.build else None
        if annotation in (inspect.Parameter.empty, typing.Any, object):
            return value
        origin = typing.get_origin(annotation)
        members = typing.get_args(annotation)
        if origin in (typing.Union, types.UnionType):
            if value is None and type(None) in members:
                return None
            reasons = []
            for member in (m for m in members if m is not type(None)):
                try:
                    return self.value(value, member, depth + 1, nesting)
                except Invalid as error:
                    reasons.append(str(error))
            raise Invalid(" and ".join(reasons) or "no member of the union fits")
        if origin is typing.Literal:
            if any(
                value == member and type(value) is type(member) for member in members
            ):
                return value
            raise Invalid(f"{json.dumps(value)} is not one of {list(members)}")
        if annotation is type(None) or annotation is None:
            if value is None:
                return None
            raise Invalid("expected null")
        if annotation in (str, int, float, bool):
            fits = (
                isinstance(value, annotation)
                and not (annotation is int and isinstance(value, bool))
            ) or (
                annotation is float
                and isinstance(value, int)
                and not isinstance(value, bool)
            )
            if not fits:
                raise Invalid(
                    f"expected {annotation.__name__}, got {json.dumps(value)[:80]}"
                )
            return float(value) if annotation is float else value
        container = origin or annotation
        if container in SEQUENCES or container in SETS or container is tuple:
            if not isinstance(value, list):
                raise Invalid(
                    f"expected an array for {getattr(container, '__name__', container)}"
                )
            if container is tuple and members and members[-1] is not Ellipsis:
                if len(members) != len(value):
                    raise Invalid(f"expected {len(members)} items")
                items = [
                    self.value(v, m, depth + 1, nesting) for v, m in zip(value, members)
                ]
            else:
                item = members[0] if members else inspect.Parameter.empty
                items = [self.value(v, item, depth + 1, nesting) for v in value]
            if not self.build:
                return None
            if container in SETS:
                return frozenset(items) if container is frozenset else set(items)
            return tuple(items) if container is tuple else items
        if container in MAPPINGS:
            if not isinstance(value, dict):
                raise Invalid("expected an object")
            key_type, item_type = (
                members if len(members) == 2 else (str, inspect.Parameter.empty)
            )
            if key_type not in (str, inspect.Parameter.empty, typing.Any, object):
                raise Invalid("only string keys can be given as data")
            return {
                k: self.value(v, item_type, depth + 1, nesting)
                for k, v in value.items()
            }
        if inspect.isclass(annotation) and dataclasses.is_dataclass(annotation):
            return self.dataclass(value, annotation, depth, nesting)
        if inspect.isclass(annotation) and issubclass(annotation, enum.Enum):
            try:
                return annotation(value)
            except Exception:  # noqa: BLE001 - the tree's enum may raise anything
                raise Invalid(
                    f"{json.dumps(value)[:80]} is no {annotation.__name__}"
                ) from None
        name = getattr(annotation, "__qualname__", repr(annotation))
        raise Invalid(
            f'{name} cannot be built from data; pass {{"$call": contract, "args": {{...}}}}'
        )

    def dataclass(self, value, cls, depth: int, nesting: int):
        if not isinstance(value, dict):
            raise Invalid(f"expected an object for {cls.__name__}")
        fields = {f.name: f for f in dataclasses.fields(cls) if f.init}
        unknown = sorted(set(value) - set(fields))
        if unknown:
            raise Invalid(f"{cls.__name__} has no field {unknown[0]}")
        missing = [
            name
            for name, f in fields.items()
            if name not in value
            and f.default is dataclasses.MISSING
            and f.default_factory is dataclasses.MISSING
        ]
        if missing:
            raise Invalid(f"{cls.__name__} needs field {missing[0]}")
        try:
            hints = typing.get_type_hints(cls)
        except Exception:  # noqa: BLE001 - an annotation the tree cannot resolve counts as missing
            hints = {}
        built = {
            name: self.value(
                v, hints.get(name, inspect.Parameter.empty), depth + 1, nesting
            )
            for name, v in value.items()
        }
        return cls(**built) if self.build else None


class Encoder:
    """Encodes a return value as canonical JSON: sorted keys and sets, types named, no addresses."""

    def __init__(self):
        self.nodes = 0

    def __call__(self, value, depth: int = 0):
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            return {"$truncated": True}
        if value is None or isinstance(value, (bool, int, str)):
            return value
        if isinstance(value, float):
            return value if math.isfinite(value) else {"$float": repr(value)}
        if isinstance(value, enum.Enum):
            return {
                "$enum": type(value).__qualname__,
                "value": self(value.value, depth + 1),
            }
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            fields = {
                f.name: self(getattr(value, f.name), depth + 1)
                for f in dataclasses.fields(value)
            }
            return {"$type": type(value).__qualname__, **fields}
        if isinstance(value, abc.Mapping):
            pairs = [(self.key(k), self(v, depth + 1)) for k, v in value.items()]
            return dict(sorted(pairs))
        if isinstance(value, (set, frozenset)):
            items = [self(v, depth + 1) for v in value]
            return sorted(items, key=lambda item: json.dumps(item, sort_keys=True))
        if isinstance(value, (list, tuple)):
            return [self(v, depth + 1) for v in value]
        attributes = getattr(value, "__dict__", None)
        if isinstance(attributes, dict):
            fields = {k: self(v, depth + 1) for k, v in sorted(attributes.items())}
            return {"$type": type(value).__qualname__, **fields}
        return {"$type": type(value).__qualname__}

    def key(self, key) -> str:
        return key if isinstance(key, str) else json.dumps(self(key), sort_keys=True)


def parse_request(raw: bytes) -> dict:
    if len(raw) > MAX_REQUEST_BYTES:
        raise RequestError(f"the request exceeds {MAX_REQUEST_BYTES} bytes")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RequestError(f"the request is not JSON: {error.msg}") from None
    if not isinstance(request, dict) or set(request) != {"contracts", "calls"}:
        raise RequestError("the request must be an object with contracts and calls")
    contracts, calls = request["contracts"], request["calls"]
    if not isinstance(contracts, list) or not all(
        isinstance(c, str) for c in contracts
    ):
        raise RequestError("contracts must be an array of strings")
    if not isinstance(calls, list) or len(calls) > MAX_CALLS:
        raise RequestError(f"calls must be an array of at most {MAX_CALLS}")
    for call in calls:
        if (
            not isinstance(call, dict)
            or set(call) != {"id", "contract", "args"}
            or not isinstance(call["id"], str)
            or not isinstance(call["contract"], str)
        ):
            raise RequestError("each call must be an object with id, contract and args")
    return request


def run(tree: str, request: dict) -> list:
    sys.path.insert(0, tree)
    contracts = frozenset(request["contracts"])
    checker = Builder(contracts, build=False)
    builder = Builder(contracts, build=True)
    results = {}
    checked = []
    # Every input is checked against its signature before any of them runs.
    for call in request["calls"]:
        try:
            checker.call(call["contract"], call["args"])
            checked.append(call)
        except Invalid as error:
            results[call["id"]] = {
                "id": call["id"],
                "status": "invalid",
                "reason": str(error)[:1000],
            }
    for call in checked:
        started = time.perf_counter()
        try:
            target, built = builder.call(call["contract"], call["args"])
            value = target(**built)
            outcome = {"status": "returned", "value": Encoder()(value)}
        except Invalid as error:
            outcome = {"status": "invalid", "reason": str(error)[:1000]}
        except Exception as error:  # noqa: BLE001 - what the tree's code raises is the outcome
            outcome = {
                "status": "raised",
                "error": {
                    "type": type(error).__qualname__,
                    "message": str(error)[:1000],
                },
            }
        outcome["ms"] = round((time.perf_counter() - started) * 1000, 3)
        results[call["id"]] = {"id": call["id"], **outcome}
    return [results[call["id"]] for call in request["calls"] if call["id"] in results]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--tree", required=True, help="the checked-out tree whose code runs"
    )
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    # The report goes to a copy of standard output; descriptor 1 then points at standard error, so
    # nothing the tree's code prints can reach the report.
    report = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    try:
        request = parse_request(raw)
    except RequestError as error:
        sys.stderr.write(f"{TOOL}: {error}\n")
        return 2
    os.chdir(args.tree)
    results = run(os.path.realpath(args.tree), request)
    report.write(json.dumps({"tool": TOOL, "results": results}, sort_keys=True) + "\n")
    report.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
