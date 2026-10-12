from shared.platform.fake_processor import FakeProcessor
from shared.platform.http import Client

PROCESSOR_URL = "https://processor.example.invalid"


def test_a_request_reaches_the_processor_once():
    processor = FakeProcessor()
    response = Client(PROCESSOR_URL, processor).post(
        "/v1/charges", {"reference": "o-1", "customer_id": "cus_7", "amount_cents": 499}
    )
    assert response.status == 200
    assert len(processor.movements_for("o-1")) == 1


def test_a_repeated_idempotency_key_moves_money_once():
    processor = FakeProcessor()
    client = Client(PROCESSOR_URL, processor)
    body = {"reference": "o-2", "customer_id": "cus_7", "amount_cents": 499}
    client.post("/v1/charges", body, {"Idempotency-Key": "charge-o-2"})
    client.post("/v1/charges", body, {"Idempotency-Key": "charge-o-2"})
    assert len(processor.movements_for("o-2")) == 1
