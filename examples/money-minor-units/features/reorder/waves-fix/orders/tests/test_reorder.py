from orders.model import Line, Order
from orders.reorder import reorder_estimate
from shared.money import Money

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_estimate_uses_todays_prices():
    """A reorder estimate prices each line at today's price."""
    today = {"milk": Money(159, "USD"), "bread": Money(325, "USD")}
    assert reorder_estimate(ORDER, today) == Money(643, "USD")
