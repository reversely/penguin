from integrations.shipping import quote
from integrations.tests.fake_carrier import FakeCarrier
from shared.http import Client


def test_quote_returns_the_carrier_rate():
    client = Client("https://carrier.example.invalid", FakeCarrier())
    assert quote(client, 2000, "GB") == 400
