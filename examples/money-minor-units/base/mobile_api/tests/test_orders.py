from mobile_api.orders import order_payload
from orders.model import Line, Order

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_order_payload_carries_the_total_twice():
    assert order_payload(ORDER) == {
        "id": "o-1",
        "currency": "USD",
        "total": "$6.23",
        "total_minor": 623,
    }
