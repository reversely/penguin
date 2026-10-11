from orders.model import Line, Order
from payouts.statements import statement_line

ORDERS = [
    Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
    Order("o-2", "NJ", "USD", [Line("coffee", 1, 10.0)]),
]


def test_statement_shows_the_weeks_payout():
    assert statement_line("Corner Grocer", ORDERS) == "Corner Grocer receives $13.80"
