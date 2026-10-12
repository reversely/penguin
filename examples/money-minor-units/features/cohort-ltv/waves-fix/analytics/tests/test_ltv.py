from analytics.ltv import lifetime_value
from orders.model import Line, Order
from shared.money import Money

CUSTOMERS = {
    "c-2": [Order("o-2", "CA", "USD", [Line("eggs", 1, 4.1)])],
    "c-1": [
        Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
        Order("o-0", "WA", "USD", [Line("rice", 3, 2.0)]),
    ],
}


def test_lifetime_value_sums_every_order():
    """A customer's lifetime value is the sum of their order totals."""
    assert lifetime_value(CUSTOMERS) == {
        "c-1": Money(1223, "USD"),
        "c-2": Money(410, "USD"),
    }
