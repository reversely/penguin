"""The HTTP client every scope uses, owned by the platform scope.

Every scope imports the client from this module, never from ``vendor/`` directly, so the import
below picks the client version for the whole repository.
"""

from vendor.wire_v2 import Client, Request, Response, Timeout, __version__

__all__ = ["Client", "Request", "Response", "Timeout", "__version__", "post_once"]


def post_once(client: Client, path: str, body: dict) -> Response:
    """Send a request that moves money, so the money moves once however often it is sent.

    wire 2.0.0 retries a timed-out request. The ``Idempotency-Key`` header is the body's
    ``reference``, the order or payout the money moves for, so a retried request carries the same
    key and the processor answers it without moving money again.
    """
    return client.post(path, body, {"Idempotency-Key": str(body["reference"])})
