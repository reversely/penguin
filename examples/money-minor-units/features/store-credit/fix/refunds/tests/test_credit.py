from orders.model import Line, Order
from refunds.credit import store_credit
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_credit_adds_the_bonus():
    assert store_credit(ORDER, ["milk"]) == Money(328, "USD")
