"""Charging a shopper's tip through the payment processor, as its own charge on the order."""

from shared.platform.http import Client, Timeout

PAID = "paid"
DECLINED = "declined"
# The processor did not answer in time. The tip may or may not have been charged; a later
# reconciliation against the processor's records settles it.
UNCONFIRMED = "unconfirmed"


def idempotency_key(order_id: str) -> str:
    """The key that makes the processor charge the tip on ``order_id`` at most once.

    The key depends only on the order, so a retried request carries the same key and the
    processor returns the first charge.
    """
    return f"tip-{order_id}"


def charge_tip(client: Client, order_id: str, customer_id: str, cents: int) -> str:
    """Charge the tip on ``order_id`` and return its status: PAID, DECLINED or UNCONFIRMED."""
    body = {
        "reference": f"tip-{order_id}",
        "customer_id": customer_id,
        "amount_cents": cents,
    }
    try:
        response = client.post(
            "/v1/charges", body, {"Idempotency-Key": idempotency_key(order_id)}
        )
    except Timeout:
        return UNCONFIRMED
    return PAID if response.status == 200 else DECLINED
