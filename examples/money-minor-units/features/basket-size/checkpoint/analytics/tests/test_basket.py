from analytics.basket import average_basket
from orders.model import Line, Order

ORDERS = [
    Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
    Order("o-2", "CA", "USD", [Line("eggs", 1, 4.1)]),
    Order("o-0", "WA", "USD", [Line("rice", 3, 2.0)]),
]


def test_average_basket_is_the_mean_order_total():
    """The average basket is the mean of the order totals."""
    assert average_basket(ORDERS) == 5.44
