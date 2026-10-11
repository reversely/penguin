from analytics.basket import average_basket
from orders.model import Line, Order
from shared.money import Money


def usd(cents: int) -> Money:
    return Money(cents, "USD")


ORDERS = [
    Order("o-1", "NY", "USD", [Line("milk", 2, usd(149)), Line("bread", 1, usd(325))]),
    Order("o-2", "CA", "USD", [Line("eggs", 1, usd(410))]),
    Order("o-0", "WA", "USD", [Line("rice", 3, usd(200))]),
]


def test_average_basket_is_the_mean_order_total():
    """The average basket is the mean of the order totals."""
    assert average_basket(ORDERS) == usd(544)
