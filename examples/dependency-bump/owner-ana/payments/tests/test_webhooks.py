from payments.orders import Order
from payments.tests.fake_processor import FakeProcessor
from payments.webhooks import DECLINED, PAID, handle_order_placed
from shared.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def test_placed_order_is_charged_once_and_paid():
    processor = FakeProcessor()
    status = handle_order_placed(
        Client(PROCESSOR_URL, processor), Order("ord_1001", "cus_7", 4999)
    )
    assert status == PAID
    assert len(processor.charges_for("ord_1001")) == 1


def test_declined_card_marks_the_order_declined():
    processor = FakeProcessor()
    status = handle_order_placed(
        Client(PROCESSOR_URL, processor), Order("ord_1002", "cus_declined", 4999)
    )
    assert status == DECLINED
    assert processor.charges_for("ord_1002") == []


def test_timed_out_charge_is_charged_once():
    """A payment is charged at most once."""
    # The processor charges the card, then its response is lost and the call times out.
    processor = FakeProcessor(lost_responses=1)
    handle_order_placed(
        Client(PROCESSOR_URL, processor), Order("ord_1003", "cus_7", 4999)
    )
    charges = processor.charges_for("ord_1003")
    assert len(charges) == 1, (
        f"{len(charges)} charges for one payment of order ord_1003"
    )
