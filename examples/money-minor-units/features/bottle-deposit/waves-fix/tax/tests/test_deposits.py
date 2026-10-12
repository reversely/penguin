from orders.model import Line, Order
from shared.money import Money
from tax.deposits import bottle_deposit

ORDER = Order("o-6", "NY", "USD", [Line("water", 6, 0.99), Line("bread", 1, 3.25)])


def test_deposit_is_charged_per_bottle():
    """A bottle deposit is charged for each bottle in the order."""
    assert bottle_deposit(ORDER, {"water"}) == Money(30, "USD")
