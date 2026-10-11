"""The store's order webhooks: charge each placed order through the payment processor."""

from payments.orders import Order, charge_body
from shared.http import Client, Timeout

PAID = "paid"
DECLINED = "declined"
# The processor did not answer in time. The charge may or may not have gone through; a later
# reconciliation against the processor's records settles it.
UNCONFIRMED = "unconfirmed"


def idempotency_key(order: Order) -> str:
    """Return the key that makes the processor charge ``order`` at most once.

    The key depends only on the order, so a retried request, from the HTTP client or from a
    redelivered webhook, carries the same key and the processor returns the first charge.
    """
    return f"charge-{order.id}"


def handle_order_placed(client: Client, order: Order) -> str:
    """Charge ``order`` and return its payment status: PAID, DECLINED or UNCONFIRMED."""
    try:
        response = client.post(
            "/v1/charges",
            charge_body(order),
            {"Idempotency-Key": idempotency_key(order)},
        )
    except Timeout:
        return UNCONFIRMED
    return PAID if response.status == 200 else DECLINED
