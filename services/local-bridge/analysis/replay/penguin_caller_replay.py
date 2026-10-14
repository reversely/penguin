"""A pytest plugin that records every call into a changed function, for Penguin's caller replay.

The check runner loads it into a caller's own test command with ``-p penguin_caller_replay`` (through
``PYTEST_ADDOPTS``, with this folder on ``PYTHONPATH``). It needs two environment variables:

- ``PENGUIN_CALLER_REPLAY_SPEC``: a JSON file ``{"version": 1, "symbols": [{"symbol": NAME,
  "module": MODULE, "qualname": QUALNAME}]}`` naming the changed functions and methods to wrap.
- ``PENGUIN_CALLER_REPLAY_OUT``: where the plugin writes what it recorded, as one JSON object.

Before any test module is collected the plugin wraps each named function where it is defined and
where it is re-exported. Each call through a wrapper records the test that made it, the frames of
the tree that led to it, its arguments, its return value or the exception it raised, and its
effects: each request object handed to a transport (an object with string ``method`` and ``url``
attributes, the shape of a vendored HTTP client's request), each ``http.client`` request, each socket
connect or send, and each file opened for writing, moved or removed, with the written file's digest.

Recorded values are data only. Each value is encoded as canonical JSON: sorted keys and sets, types
named, memory addresses removed. A value the encoder cannot read field by field is kept as its
``repr`` and marked approximate. An encoding over the size cap is kept as its SHA-256, its length
and a short preview. Nothing recorded is ever evaluated, here or by the bridge.

The plugin changes no result: each wrapper returns what the function returned and re-raises what it
raised, and a failure inside the plugin's own recording is counted, never raised into the test.
"""

import builtins
import dataclasses
import enum
import functools
import hashlib
import http.client
import importlib
import inspect
import io
import json
import math
import os
import re
import socket
import sys
import threading
from collections import abc

TOOL = "caller-replay"
VERSION = 1
SPEC_VARIABLE = "PENGUIN_CALLER_REPLAY_SPEC"
OUT_VARIABLE = "PENGUIN_CALLER_REPLAY_OUT"

MAX_SYMBOLS = 64
MAX_CALLS = 5_000
MAX_EFFECTS_PER_CALL = 32
MAX_FRAMES = 24
MAX_DEPTH = 24
MAX_NODES = 5_000
# The JSON text of one recorded value; a longer one is kept as its digest and a preview.
MAX_VALUE_CHARS = 2_048
# One field of an effect: its body, headers or address.
MAX_EFFECT_FIELD_CHARS = 600
MAX_TEXT = 500
PREVIEW = 200

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
ADDRESS = re.compile(r" at 0x[0-9A-Fa-f]+")
WRITE_MODES = frozenset("wax+")
# The plugin's own files are read and written with the open the interpreter started with.
ORIGINAL_OPEN = builtins.open


def strip(text: str, limit: int = MAX_TEXT) -> str:
    """Text without memory addresses, which differ between runs, cut to ``limit`` characters."""
    return ADDRESS.sub(" at 0x?", text)[:limit]


class Encoder:
    """Encodes a value as canonical JSON-safe data and notes whether any part is approximate."""

    def __init__(self) -> None:
        self.nodes = 0
        self.approximate = False
        self.active: set[int] = set()

    def __call__(self, value, depth: int = 0):
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            return {"$truncated": True}
        if value is None or isinstance(value, (bool, int, str)):
            return value if not isinstance(value, str) else value[:MAX_VALUE_CHARS]
        if isinstance(value, float):
            return value if math.isfinite(value) else {"$float": repr(value)}
        if isinstance(value, (bytes, bytearray, memoryview)):
            data = bytes(value)
            return {"$bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if isinstance(value, enum.Enum):
            return {
                "$enum": type(value).__qualname__,
                "value": self(value.value, depth + 1),
            }
        if isinstance(value, type):
            return {"$class": f"{value.__module__}.{value.__qualname__}"}
        if inspect.isroutine(value) or isinstance(value, functools.partial):
            name = getattr(value, "__qualname__", type(value).__qualname__)
            return {"$callable": strip(str(name), 200)}
        if id(value) in self.active:
            return {"$cycle": type(value).__qualname__}
        self.active.add(id(value))
        try:
            return self.container(value, depth)
        finally:
            self.active.discard(id(value))

    def container(self, value, depth: int):
        if dataclasses.is_dataclass(value):
            fields = {
                f.name: self(getattr(value, f.name, None), depth + 1)
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
        slots = [
            s
            for c in type(value).__mro__
            for s in getattr(c, "__slots__", ())
            if isinstance(s, str)
        ]
        if isinstance(attributes, dict) or slots:
            fields = dict(sorted((attributes or {}).items()))
            for name in slots:
                if name not in fields and hasattr(value, name):
                    fields[name] = getattr(value, name)
            encoded = {
                k: self(v, depth + 1)
                for k, v in fields.items()
                if isinstance(k, str) and not k.startswith("__")
            }
            return {"$type": type(value).__qualname__, **encoded}
        self.approximate = True
        try:
            text = repr(value)
        except Exception:  # noqa: BLE001 - the tree's __repr__ may raise anything
            text = type(value).__qualname__
        return {"$repr": strip(text, PREVIEW), "$type": type(value).__qualname__}

    def key(self, key) -> str:
        return key if isinstance(key, str) else json.dumps(self(key), sort_keys=True)


def encode(value, limit: int = MAX_VALUE_CHARS) -> tuple[object, bool]:
    """A value as canonical JSON data capped at ``limit`` characters, and whether it is approximate."""
    encoder = Encoder()
    try:
        data = encoder(value)
    except Exception as error:  # noqa: BLE001 - a property of the tree's object may raise anything
        return {
            "$repr": strip(
                f"<unreadable {type(value).__qualname__}: {type(error).__name__}>"
            ),
            "$type": type(value).__qualname__,
        }, True
    return capped(data, limit), encoder.approximate


def capped(data, limit: int = MAX_VALUE_CHARS):
    text = json.dumps(data, sort_keys=True, separators=(",", ":"))
    if len(text) <= limit:
        return data
    return {
        "$truncated": True,
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "chars": len(text),
        "preview": text[:PREVIEW],
    }


class Recorder:
    """What one test run records: calls, test outcomes and the plugin's own problems."""

    def __init__(self, root: str, out: str) -> None:
        self.root = root
        self.out = out
        self.paths: dict[str, str | None] = {}
        self.calls: list[dict] = []
        self.dropped = 0
        self.tests: dict[str, str] = {}
        self.test = "<collection>"
        self.symbols: list[dict] = []
        self.problems = 0
        self.local = threading.local()

    def state(self):
        """This thread's calls in progress (innermost last) and its count of plugin work under way."""
        if not hasattr(self.local, "stack"):
            self.local.stack = []
            self.local.quiet = 0
        return self.local

    def active(self) -> list[dict]:
        return self.state().stack

    def quiet(self) -> bool:
        return self.state().quiet > 0

    def hush(self, step: int) -> None:
        """Counts plugin work starting (1) or ending (-1); effects made meanwhile are the plugin's own."""
        self.state().quiet += step

    def tree_path(self, filename: str) -> str | None:
        """A code file's path in the tree, or None for a file outside it, such as the standard library."""
        if filename not in self.paths:
            full = os.path.realpath(filename)
            inside = full.startswith(self.root + os.sep) and not full.endswith(
                "penguin_caller_replay.py"
            )
            self.paths[filename] = (
                os.path.relpath(full, self.root).replace(os.sep, "/")
                if inside
                else None
            )
        return self.paths[filename]

    def frames(self, frame) -> list[dict]:
        """The frames of the tree's own files that led to a call, innermost first."""
        found = []
        while frame is not None and len(found) < MAX_FRAMES:
            path = self.tree_path(frame.f_code.co_filename)
            if path is not None:
                found.append(
                    {
                        "path": path,
                        "line": frame.f_lineno,
                        "function": frame.f_code.co_name,
                    }
                )
            frame = frame.f_back
        return found

    def effect(self, kind: str, detail: dict) -> None:
        stack = self.active()
        if not stack or self.quiet():
            return
        self.hush(1)
        try:
            # Each field is capped on its own, so a long body keeps the method and URL beside it.
            fields = {
                key: encode(value, MAX_EFFECT_FIELD_CHARS)
                for key, value in detail.items()
            }
            data = {key: field[0] for key, field in fields.items()}
            approximate = any(field[1] for field in fields.values())
            for call in stack:
                call["effectCount"] += 1
                if len(call["effects"]) < MAX_EFFECTS_PER_CALL:
                    call["effects"].append({"kind": kind, "detail": data})
                call["approximate"] = call["approximate"] or approximate
        finally:
            self.hush(-1)

    def written(self, path) -> None:
        stack = self.active()
        if stack and not self.quiet():
            for call in stack:
                call.setdefault("_written", []).append(os.fspath(path))

    def place(self, path) -> str:
        """A written path as the tree names it, or ``$outside/<name>`` for a path outside the tree."""
        full = os.path.realpath(os.fspath(path))
        if full.startswith(self.root + os.sep):
            return os.path.relpath(full, self.root).replace(os.sep, "/")
        return f"$outside/{os.path.basename(full)}"


RECORDER: Recorder | None = None


def wrap(recorder: Recorder, symbol: str, original):
    """A function that records each call of ``original`` and behaves exactly as it does."""

    try:
        signature = inspect.signature(original)
    except (TypeError, ValueError):
        signature = None

    @functools.wraps(original)
    def wrapper(*args, **kwargs):
        stack = recorder.active()
        if recorder.quiet() or len(recorder.calls) >= MAX_CALLS:
            if not recorder.quiet():
                recorder.dropped += 1
            return original(*args, **kwargs)
        call = start(recorder, symbol, signature, args, kwargs, sys._getframe(1))
        # The outermost wrapped call watches for requests; an inner one shares what it sees.
        outermost = not stack
        stack.append(call)
        profile = sys.getprofile()
        if outermost:
            sys.setprofile(Watcher(recorder, profile))
        try:
            result = original(*args, **kwargs)
        except BaseException as error:
            if outermost:
                sys.setprofile(profile)
            stack.pop()
            finish(recorder, call, error=error)
            raise
        if outermost:
            sys.setprofile(profile)
        stack.pop()
        finish(recorder, call, result=result)
        return result

    wrapper.__penguin_replay__ = True
    return wrapper


def start(recorder: Recorder, symbol: str, signature, args, kwargs, frame) -> dict:
    recorder.hush(1)
    try:
        try:
            named = dict(signature.bind_partial(*args, **kwargs).arguments)
        except (AttributeError, TypeError):
            named = {"args": list(args), "kwargs": kwargs}
        data, approximate = encode(named)
        call = {
            "symbol": symbol,
            "test": recorder.test,
            "frames": recorder.frames(frame),
            "args": data,
            "approximate": approximate,
            "effects": [],
            "effectCount": 0,
        }
        recorder.calls.append(call)
        return call
    finally:
        recorder.hush(-1)


def finish(
    recorder: Recorder, call: dict, result=None, error: BaseException | None = None
) -> None:
    recorder.hush(1)
    try:
        if error is None:
            data, approximate = encode(result)
            call["outcome"] = {"status": "returned", "value": data}
            call["approximate"] = call["approximate"] or approximate
        else:
            call["outcome"] = {
                "status": "raised",
                "error": {
                    "type": type(error).__qualname__,
                    "message": strip(str(error)),
                },
            }
        for path in call.pop("_written", []):
            detail = {"path": recorder.place(path)}
            try:
                with ORIGINAL_OPEN(path, "rb") as handle:
                    content = handle.read()
                detail.update(
                    {
                        "bytes": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                )
            except OSError:
                detail["missing"] = True
            if len(call["effects"]) < MAX_EFFECTS_PER_CALL:
                call["effects"].append({"kind": "file-content", "detail": detail})
            call["effectCount"] += 1
    except Exception:  # noqa: BLE001 - recording never changes the test's outcome
        recorder.problems += 1
    finally:
        recorder.hush(-1)


class Watcher:
    """A profile function, set while a wrapped call runs, that records request objects handed to a callable."""

    def __init__(self, recorder: Recorder, previous) -> None:
        self.recorder = recorder
        self.previous = previous
        self.inside: list[object] = []

    def __call__(self, frame, event, arg):
        if self.previous is not None:
            self.previous(frame, event, arg)
        if event == "return" and self.inside and self.inside[-1] is frame:
            self.inside.pop()
            return
        if event != "call" or self.inside or self.recorder.quiet():
            return
        code = frame.f_code
        if code.co_filename.endswith("penguin_caller_replay.py"):
            return
        count = code.co_argcount + code.co_kwonlyargcount
        names = code.co_varnames[:count]
        for index, name in enumerate(names):
            if index == 0 and name in ("self", "cls"):
                continue
            value = frame.f_locals.get(name)
            method = getattr(value, "method", None) if value is not None else None
            url = getattr(value, "url", None) if value is not None else None
            if isinstance(method, str) and isinstance(url, str):
                body = getattr(value, "json", None)
                if body is None:
                    body = getattr(value, "data", None)
                headers = getattr(value, "headers", None)
                via = getattr(code, "co_qualname", code.co_name)
                self.recorder.effect(
                    "request",
                    {
                        "via": via,
                        "method": method,
                        "url": url,
                        "body": body,
                        "headers": headers,
                    },
                )
                self.inside.append(frame)
                return


def patch_effects(recorder: Recorder) -> None:
    """Wraps the standard library's ways out of the process, so a call's effects are recorded."""
    request = http.client.HTTPConnection.request

    def http_request(self, method, url, body=None, headers=None, **kwargs):
        recorder.effect(
            "http",
            {
                "method": method,
                "host": self.host,
                "port": self.port,
                "url": url,
                "body": body,
                "headers": dict(headers or {}),
            },
        )
        recorder.hush(1)
        try:
            return request(self, method, url, body, headers or {}, **kwargs)
        finally:
            recorder.hush(-1)

    http.client.HTTPConnection.request = http_request

    for name in ("connect", "connect_ex", "sendto", "sendall", "send"):
        original = getattr(socket.socket, name)

        def socket_method(self, *args, _name=name, _original=original):
            detail = {"op": _name}
            if _name in ("connect", "connect_ex"):
                detail["address"] = args[0] if args else None
            elif _name == "sendto":
                detail["address"] = args[-1] if args else None
                detail["data"] = args[0] if args else None
            else:
                detail["data"] = args[0] if args else None
            recorder.effect("socket", detail)
            return _original(self, *args)

        setattr(socket.socket, name, socket_method)

    def open_file(file, mode="r", *args, **kwargs):
        handle = ORIGINAL_OPEN(file, mode, *args, **kwargs)
        if isinstance(file, (str, bytes, os.PathLike)) and WRITE_MODES & set(str(mode)):
            recorder.effect(
                "file", {"op": "open", "path": recorder.place(file), "mode": str(mode)}
            )
            recorder.written(file)
        return handle

    builtins.open = open_file
    io.open = open_file

    for name in ("remove", "unlink", "rename", "replace"):
        original = getattr(os, name)

        def os_method(*args, _name=name, _original=original, **kwargs):
            paths = [
                recorder.place(a)
                for a in args[:2]
                if isinstance(a, (str, bytes, os.PathLike))
            ]
            recorder.effect("file", {"op": _name, "paths": paths})
            return _original(*args, **kwargs)

        setattr(os, name, os_method)


def install(recorder: Recorder, symbols: list[dict]) -> None:
    """Wraps each named function where it is defined and where the named module re-exports it."""
    for entry in symbols[:MAX_SYMBOLS]:
        symbol, module_name, qualname = (
            entry.get("symbol"),
            entry.get("module"),
            entry.get("qualname"),
        )
        if not all(
            isinstance(v, str) and NAME.match(v)
            for v in (symbol, module_name, qualname)
        ):
            recorder.symbols.append(
                {
                    "symbol": str(symbol)[:200],
                    "status": "unresolved",
                    "reason": "not a dotted name",
                }
            )
            continue
        try:
            recorder.symbols.append(
                {
                    "symbol": symbol,
                    **wrap_symbol(recorder, symbol, module_name, qualname),
                }
            )
        except Exception as error:  # noqa: BLE001 - the tree's module may raise anything on import
            recorder.symbols.append(
                {
                    "symbol": symbol,
                    "status": "unresolved",
                    "reason": strip(f"{type(error).__name__}: {error}", 300),
                }
            )


def wrap_symbol(
    recorder: Recorder, symbol: str, module_name: str, qualname: str
) -> dict:
    module = importlib.import_module(module_name)
    *outer, name = qualname.split(".")
    owner = module
    for part in outer:
        owner = getattr(owner, part)
    raw = inspect.getattr_static(owner, name)
    kind = type(raw) if isinstance(raw, (staticmethod, classmethod)) else None
    function = raw.__func__ if kind is not None else raw
    if not callable(function):
        return {"status": "unresolved", "reason": "not callable"}
    if getattr(function, "__penguin_replay__", False):
        return {"status": "wrapped"}
    wrapper = wrap(recorder, symbol, function)
    setattr(owner, name, kind(wrapper) if kind is not None else wrapper)
    # A function re-exported from where it is defined is wrapped there too.
    if (
        not outer
        and inspect.isfunction(function)
        and function.__module__ != module_name
    ):
        home = sys.modules.get(function.__module__)
        if home is not None and getattr(home, function.__name__, None) is function:
            setattr(home, function.__name__, wrapper)
    return {"status": "wrapped"}


def pytest_configure(config) -> None:
    global RECORDER
    spec_path, out_path = os.environ.get(SPEC_VARIABLE), os.environ.get(OUT_VARIABLE)
    if not spec_path or not out_path or RECORDER is not None:
        return
    with ORIGINAL_OPEN(spec_path, encoding="utf-8") as handle:
        spec = json.load(handle)
    RECORDER = Recorder(os.path.realpath(str(config.rootpath)), out_path)
    # The changed modules import from the tree's root, as `python -m pytest` run there would.
    if os.getcwd() not in sys.path and "" not in sys.path:
        sys.path.insert(0, os.getcwd())
    patch_effects(RECORDER)
    install(RECORDER, spec.get("symbols", []) if isinstance(spec, dict) else [])


def pytest_runtest_logstart(nodeid, location) -> None:
    if RECORDER is not None:
        RECORDER.test = nodeid


# A test's outcome is the worst of its phases: an `error` died with an exception other than a failed
# assertion, or failed to set up or collect.
RANK = {"passed": 0, "skipped": 1, "failed": 2, "error": 3}


def outcome(nodeid: str, value: str) -> None:
    if RECORDER is None:
        return
    seen = RECORDER.tests.get(nodeid)
    if seen is None or RANK[value] > RANK[seen]:
        RECORDER.tests[nodeid] = value


def pytest_runtest_logreport(report) -> None:
    if report.failed:
        outcome(report.nodeid, "failed" if report.when == "call" else "error")
    elif report.skipped:
        outcome(report.nodeid, "skipped")
    elif report.when == "call":
        outcome(report.nodeid, "passed")


def pytest_exception_interact(node, call, report) -> None:
    if (
        call.excinfo is not None
        and not call.excinfo.errisinstance(AssertionError)
        and report.failed
    ):
        outcome(report.nodeid, "error")


def pytest_runtest_logfinish(nodeid, location) -> None:
    if RECORDER is not None:
        RECORDER.test = "<collection>"


def pytest_collectreport(report) -> None:
    if report.failed:
        outcome(report.nodeid or "<collection>", "error")


def pytest_unconfigure(config) -> None:
    if RECORDER is None:
        return
    report = {
        "tool": TOOL,
        "version": VERSION,
        "symbols": RECORDER.symbols,
        "calls": RECORDER.calls,
        "dropped": RECORDER.dropped,
        "tests": RECORDER.tests,
        "problems": RECORDER.problems,
    }
    with ORIGINAL_OPEN(RECORDER.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, sort_keys=True, separators=(",", ":"))
