"""Sending an instant payout to a store through the payment processor."""

from shared.platform.http import Client, Timeout, idempotency_key

SENT = "sent"
REFUSED = "refused"
# The processor did not answer in time. The payout may or may not have gone out; a later
# reconciliation against the processor's records settles it.
UNCONFIRMED = "unconfirmed"


def send_instant_payout(
    client: Client, payout_id: str, store_id: str, cents: int
) -> str:
    """Send ``cents`` to the store and return the payout's status: SENT, REFUSED or UNCONFIRMED."""
    body = {"reference": payout_id, "store_id": store_id, "amount_cents": cents}
    try:
        response = client.post(
            "/v1/payouts",
            body,
            {"Idempotency-Key": idempotency_key("payout", payout_id)},
        )
    except Timeout:
        return UNCONFIRMED
    return SENT if response.status == 200 else REFUSED
