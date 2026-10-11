from integrations.shipping import quote
from integrations.tests.fake_carrier import FakeCarrier
from shared.http import Client


def test_quote_returns_the_carrier_rate():
    client = Client("https://carrier.example.invalid", FakeCarrier())
    assert quote(client, 2000, "GB") == 400


def test_quote_survives_one_dropped_request():
    # The carrier drops the first request after a quiet period; the client retries it.
    carrier = FakeCarrier(dropped=1)
    client = Client("https://carrier.example.invalid", carrier)
    assert quote(client, 2000, "GB") == 400
    assert len(carrier.requests) == 2
