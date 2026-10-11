from analytics.ltv import lifetime_value
from orders.model import Line, Order
from shared.money import Money


def usd(cents: int) -> Money:
    return Money(cents, "USD")


CUSTOMERS = {
    "c-2": [Order("o-2", "CA", "USD", [Line("eggs", 1, usd(410))])],
    "c-1": [
        Order(
            "o-1", "NY", "USD", [Line("milk", 2, usd(149)), Line("bread", 1, usd(325))]
        ),
        Order("o-0", "WA", "USD", [Line("rice", 3, usd(200))]),
    ],
}


def test_lifetime_value_sums_every_order():
    """A customer's lifetime value is the sum of their order totals."""
    assert lifetime_value(CUSTOMERS) == {"c-1": usd(1223), "c-2": usd(410)}
