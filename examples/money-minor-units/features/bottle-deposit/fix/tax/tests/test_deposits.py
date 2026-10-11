from orders.model import Line, Order
from shared.money import Money
from tax.deposits import bottle_deposit

ORDER = Order(
    "o-6",
    "NY",
    "USD",
    [Line("water", 6, Money(99, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_deposit_is_charged_per_bottle():
    assert bottle_deposit(ORDER, {"water"}) == Money(30, "USD")
