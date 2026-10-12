from orders.model import Line, Order, line_total_minor, order_total_minor
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
    assert Order.from_record(RECORD).lines[0] == Line("milk", 2, 1.49)


def test_line_total_minor_is_price_times_quantity():
    """A line's total is its price times its quantity."""
    assert line_total_minor(Line("milk", 2, 1.49), "USD") == Money(298, "USD")


def test_order_total_minor_sums_the_lines():
    """An order's total is the sum of its line totals."""
    assert order_total_minor(Order.from_record(RECORD)) == Money(623, "USD")
