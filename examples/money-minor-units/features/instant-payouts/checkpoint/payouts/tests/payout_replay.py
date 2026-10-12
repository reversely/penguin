"""Replay an instant payout against the fake payment processor, for side-by-side runs."""

from payouts.send import send_instant_payout
from shared.platform.fake_processor import FakeProcessor
from shared.platform.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def payouts_sent(
    payout_id: str, store_id: str, cents: int, lost_responses: int = 0
) -> list[dict]:
    """Send the payout and return what the processor paid out for it.

    The processor loses its first ``lost_responses`` responses after paying, so the client sees a
    timeout although the store was paid.
    """
    processor = FakeProcessor(lost_responses=lost_responses)
    send_instant_payout(Client(PROCESSOR_URL, processor), payout_id, store_id, cents)
    return processor.movements_for(payout_id)
