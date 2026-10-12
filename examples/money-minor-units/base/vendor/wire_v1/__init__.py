"""wire 1.4.0: a small HTTP client, vendored into this repository.

A client sends each request through a transport: a callable that takes a ``Request`` and returns a
``Response``, or raises ``Timeout`` when no response arrives in time. The fixture's tests pass an
in-process fake as the transport, so no request leaves the process.

This version sends each request once. A timed-out request raises ``Timeout`` to the caller.
"""

from collections.abc import Callable
from dataclasses import dataclass, field

__version__ = "1.4.0"


class Timeout(Exception):
    """No response arrived before the transport's deadline."""


@dataclass(frozen=True)
class Request:
    method: str
    url: str
    json: dict
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Response:
    status: int
    json: dict


Transport = Callable[[Request], Response]


class Client:
    def __init__(self, base_url: str, transport: Transport) -> None:
        self.base_url = base_url.rstrip("/")
        self.transport = transport

    def post(
        self, path: str, json: dict, headers: dict[str, str] | None = None
    ) -> Response:
        """Send one POST request and return its response; raise ``Timeout`` if none arrives."""
        request = Request("POST", self.base_url + path, json, dict(headers or {}))
        return self.transport(request)
