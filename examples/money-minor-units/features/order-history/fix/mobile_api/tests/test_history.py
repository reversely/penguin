from mobile_api.history import history_payload
from orders.model import Line, Order
from shared.money import Money

ORDERS = [Order("o-2", "CA", "USD", [Line("eggs", 1, Money(410, "USD"))])]


def test_history_shows_each_total():
    assert history_payload(ORDERS) == [{"id": "o-2", "total": "$4.10"}]
