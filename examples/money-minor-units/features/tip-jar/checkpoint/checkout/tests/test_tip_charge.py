from checkout.tip_charge import DECLINED, PAID, charge_tip
from shared.platform.fake_processor import FakeProcessor
from shared.platform.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def test_a_tip_is_charged_once_and_paid():
    processor = FakeProcessor()
    status = charge_tip(Client(PROCESSOR_URL, processor), "o-1", "cus_7", 62)
    assert status == PAID
    assert len(processor.movements_for("tip-o-1")) == 1


def test_a_declined_card_declines_the_tip():
    processor = FakeProcessor()
    status = charge_tip(Client(PROCESSOR_URL, processor), "o-2", "cus_declined", 62)
    assert status == DECLINED
    assert processor.movements_for("tip-o-2") == []


def test_timed_out_tip_is_charged_once():
    """A shopper is charged at most once per order."""
    # The processor charges the card, then its response is lost and the call times out.
    processor = FakeProcessor(lost_responses=1)
    charge_tip(Client(PROCESSOR_URL, processor), "o-3", "cus_7", 62)
    charges = processor.movements_for("tip-o-3")
    assert len(charges) == 1, f"{len(charges)} charges for the tip on order o-3"
