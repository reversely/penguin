"""Replay a tip charge against the fake payment processor, for side-by-side runs."""

from checkout.tip_charge import charge_tip
from shared.platform.fake_processor import FakeProcessor
from shared.platform.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def tip_charges(
    order_id: str, customer_id: str, cents: int, lost_responses: int = 0
) -> list[dict]:
    """Charge the tip and return the charges the processor made for it.

    The processor loses its first ``lost_responses`` responses after charging, so the client sees
    a timeout although the card was charged.
    """
    processor = FakeProcessor(lost_responses=lost_responses)
    charge_tip(Client(PROCESSOR_URL, processor), order_id, customer_id, cents)
    return processor.movements_for(f"tip-{order_id}")
