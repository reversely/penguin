from orders.model import Line, Order
from shared.money import Money
from tax.exempt import tax_due

ORDER = Order("o-4", "NJ", "USD", [Line("coffee", 1, Money(1000, "USD"))])


def test_exempt_customers_owe_no_tax():
    """A tax-exempt customer owes no tax on an order."""
    assert tax_due(ORDER, exempt=True) == Money(0, "USD")
    assert tax_due(ORDER, exempt=False) == Money(66, "USD")
