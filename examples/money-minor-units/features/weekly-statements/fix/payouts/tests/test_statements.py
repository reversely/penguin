from orders.model import Line, Order
from payouts.statements import statement_line
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


def test_statement_shows_the_weeks_payout():
    """A store's weekly statement shows what the store receives for the week's orders."""
    assert statement_line("Corner Grocer", ORDERS) == "Corner Grocer receives $13.80"
