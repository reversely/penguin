from mobile_api.order_lines_page import order_lines_page
from orders.model import Line, Order

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_page_returns_prices_and_the_next_cursor():
    """A page of order lines carries each line's price and the next page's cursor."""
    assert order_lines_page(ORDER, 0, limit=1) == {
        "lines": [{"sku": "milk", "price": "$2.98"}],
        "next": 1,
    }
