from invoicing.business import statement_total
from orders.model import Line, Order
from shared.money import Money

ORDERS = [
    Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
    Order("o-2", "NJ", "USD", [Line("coffee", 1, 10.0)]),
]


def test_statement_sums_every_invoice():
    """A business statement's total is the sum of its invoices."""
    assert statement_total(ORDERS) == Money(1744, "USD")
