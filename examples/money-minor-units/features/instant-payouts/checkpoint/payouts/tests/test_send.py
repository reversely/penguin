from payouts.send import SENT, send_instant_payout
from shared.platform.fake_processor import FakeProcessor
from shared.platform.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def test_a_payout_is_sent_once():
    processor = FakeProcessor()
    status = send_instant_payout(Client(PROCESSOR_URL, processor), "po-1", "s-1", 480)
    assert status == SENT
    assert len(processor.movements_for("po-1")) == 1


def test_timed_out_payout_is_paid_once():
    """A store is paid out at most once."""
    # The processor pays the store, then its response is lost and the call times out.
    processor = FakeProcessor(lost_responses=1)
    send_instant_payout(Client(PROCESSOR_URL, processor), "po-2", "s-1", 480)
    payouts = processor.movements_for("po-2")
    assert len(payouts) == 1, f"{len(payouts)} payouts for payout po-2"
