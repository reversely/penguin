from messaging.digest import digest
from orders.model import Line, Order
from shared.money import Money

ORDERS = [
    Order(
        "o-1",
        "NY",
        "USD",
        [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
    ),
    Order("o-2", "CA", "USD", [Line("eggs", 1, Money(410, "USD"))]),
]


def test_digest_counts_orders_and_spend():
    assert digest(ORDERS) == "2 orders this week, $10.33 in all."
