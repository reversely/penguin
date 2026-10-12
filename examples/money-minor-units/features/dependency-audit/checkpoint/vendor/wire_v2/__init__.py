"""wire 2.0.0: a small HTTP client, vendored into this repository.

A client sends each request through a transport: a callable that takes a ``Request`` and returns a
``Response``, or raises ``Timeout`` when no response arrives in time. The fixture's tests pass an
in-process fake as the transport, so no request leaves the process.

Changed in 2.0.0: a client retries a timed-out request by default, up to ``retries`` more times
(2 unless the caller passes another value). Every attempt sends the same method, URL, body and
headers. ``Timeout`` reaches the caller only when every attempt times out.
"""

from collections.abc import Callable
from dataclasses import dataclass, field

__version__ = "2.0.0"

DEFAULT_RETRIES = 2


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
    def __init__(
        self, base_url: str, transport: Transport, retries: int = DEFAULT_RETRIES
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.transport = transport
        self.retries = retries

    def post(
        self, path: str, json: dict, headers: dict[str, str] | None = None
    ) -> Response:
        """Send a POST request, retrying on ``Timeout``; raise ``Timeout`` if every attempt does."""
        request = Request("POST", self.base_url + path, json, dict(headers or {}))
        for _ in range(self.retries):
            try:
                return self.transport(request)
            except Timeout:
                continue
        return self.transport(request)
