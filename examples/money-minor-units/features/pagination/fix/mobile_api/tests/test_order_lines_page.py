from mobile_api.order_lines_page import order_lines_page
from orders.model import Line, Order
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_page_returns_prices_and_the_next_cursor():
    assert order_lines_page(ORDER, 0, limit=1) == {
        "lines": [{"sku": "milk", "price": "$2.98"}],
        "next": 1,
    }
