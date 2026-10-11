"""Replay a placed order against the fake payment processor, for side-by-side runs."""

from payments.orders import Order
from payments.tests.fake_processor import FakeProcessor
from payments.webhooks import handle_order_placed
from shared.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def charges_for_placed_order(order: Order, lost_responses: int = 0) -> list[dict]:
    """Place ``order`` through the webhook and return the charges the processor made for it.

    The processor loses its first ``lost_responses`` responses after making the charge, so the
    client sees a timeout although the card was charged.
    """
    processor = FakeProcessor(lost_responses=lost_responses)
    handle_order_placed(Client(PROCESSOR_URL, processor), order)
    return processor.charges_for(order.id)
