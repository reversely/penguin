from mobile_api.history import history_payload
from orders.model import Line, Order

ORDERS = [Order("o-2", "CA", "USD", [Line("eggs", 1, 4.1)])]


def test_history_shows_each_total():
    assert history_payload(ORDERS) == [{"id": "o-2", "total": "$4.10"}]
