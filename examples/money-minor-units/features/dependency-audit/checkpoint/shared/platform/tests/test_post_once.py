from shared.platform.fake_processor import FakeProcessor
from shared.platform.http import Client, post_once


def test_a_retried_money_movement_moves_money_once():
    """A request the client retries after a lost response moves the money once."""
    processor = FakeProcessor(lost_responses=1)
    client = Client("https://processor.example.invalid", processor)
    body = {"reference": "o-9", "customer_id": "cus_7", "amount_cents": 499}
    assert post_once(client, "/v1/charges", body).status == 200
    assert len(processor.movements_for("o-9")) == 1
