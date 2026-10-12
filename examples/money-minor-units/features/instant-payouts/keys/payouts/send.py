"""Sending an instant payout to a store through the payment processor."""

from shared.platform.http import Client, Timeout

SENT = "sent"
REFUSED = "refused"
# The processor did not answer in time. The payout may or may not have gone out; a later
# reconciliation against the processor's records settles it.
UNCONFIRMED = "unconfirmed"


def idempotency_key(payout_id: str) -> str:
    """The key that makes the processor send payout ``payout_id`` at most once.

    The key depends only on the payout, so a retried request carries the same key and the
    processor returns the first payout.
    """
    return f"payout-{payout_id}"


def send_instant_payout(
    client: Client, payout_id: str, store_id: str, cents: int
) -> str:
    """Send ``cents`` to the store and return the payout's status: SENT, REFUSED or UNCONFIRMED."""
    body = {"reference": payout_id, "store_id": store_id, "amount_cents": cents}
    try:
        response = client.post(
            "/v1/payouts", body, {"Idempotency-Key": idempotency_key(payout_id)}
        )
    except Timeout:
        return UNCONFIRMED
    return SENT if response.status == 200 else REFUSED
