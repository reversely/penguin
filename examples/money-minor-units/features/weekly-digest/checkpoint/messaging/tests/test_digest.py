from messaging.digest import digest
from orders.model import Line, Order

ORDERS = [
    Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
    Order("o-2", "CA", "USD", [Line("eggs", 1, 4.1)]),
]


def test_digest_counts_orders_and_spend():
    assert digest(ORDERS) == "2 orders this week, $10.33 in all."
