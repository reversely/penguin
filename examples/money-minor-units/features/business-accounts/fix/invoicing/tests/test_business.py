from invoicing.business import statement_total
from orders.model import Line, Order
from shared.money import Money

ORDERS = [
    Order(
        "o-1",
        "NY",
        "USD",
        [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
    ),
    Order("o-2", "NJ", "USD", [Line("coffee", 1, Money(1000, "USD"))]),
]


def test_statement_sums_every_invoice():
    assert statement_total(ORDERS) == Money(1744, "USD")
