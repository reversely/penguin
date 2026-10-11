from orders.model import Line, Order
from orders.reorder import reorder_estimate

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_estimate_uses_todays_prices():
    assert reorder_estimate(ORDER, {"milk": 1.59, "bread": 3.25}) == 6.43
