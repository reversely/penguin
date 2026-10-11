from orders.model import Line, Order, line_total, order_total
from shared.money import Money

RECORD = {
    "id": "o-1",
    "region": "NY",
    "currency": "USD",
    "lines": [
        {"sku": "milk", "quantity": 2, "unit_price": 1.49},
        {"sku": "bread", "quantity": 1, "unit_price": 3.25},
    ],
}


def test_from_record_reads_the_stored_prices():
    assert Order.from_record(RECORD).lines[0] == Line("milk", 2, Money(149, "USD"))


def test_line_total_is_price_times_quantity():
    """A line's total is its price times its quantity."""
    assert line_total(Line("milk", 2, Money(149, "USD"))) == Money(298, "USD")


def test_order_total_sums_the_lines():
    """An order's total is the sum of its line totals."""
    assert order_total(Order.from_record(RECORD)) == Money(623, "USD")
