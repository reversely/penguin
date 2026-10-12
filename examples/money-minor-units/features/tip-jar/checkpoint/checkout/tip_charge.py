"""Charging a shopper's tip through the payment processor, as its own charge on the order."""

from shared.platform.http import Client, Timeout

PAID = "paid"
DECLINED = "declined"
# The processor did not answer in time. The tip may or may not have been charged; a later
# reconciliation against the processor's records settles it.
UNCONFIRMED = "unconfirmed"


def charge_tip(client: Client, order_id: str, customer_id: str, cents: int) -> str:
    """Charge the tip on ``order_id`` and return its status: PAID, DECLINED or UNCONFIRMED."""
    body = {
        "reference": f"tip-{order_id}",
        "customer_id": customer_id,
        "amount_cents": cents,
    }
    try:
        response = client.post("/v1/charges", body)
    except Timeout:
        return UNCONFIRMED
    return PAID if response.status == 200 else DECLINED
