"""The HTTP client every scope uses, owned by the platform scope.

Every scope imports the client from this module, never from ``vendor/`` directly, so the import
below picks the client version for the whole repository.
"""

from vendor.wire_v2 import Client, Request, Response, Timeout, __version__

__all__ = ["Client", "Request", "Response", "Timeout", "__version__", "idempotency_key"]


def idempotency_key(kind: str, reference: str) -> str:
    """Return the ``Idempotency-Key`` header value for the money movement ``reference``.

    wire 2.0.0 retries a timed-out request. The key depends only on what the money moves for, so a
    retried request carries the same key and the processor answers it without moving money again.
    """
    return f"{kind}-{reference}"
