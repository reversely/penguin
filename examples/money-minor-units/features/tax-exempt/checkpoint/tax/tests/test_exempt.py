from orders.model import Line, Order
from tax.exempt import tax_due

ORDER = Order("o-4", "NJ", "USD", [Line("coffee", 1, 10.0)])


def test_exempt_customers_owe_no_tax():
    """A tax-exempt customer owes no tax on an order."""
    assert tax_due(ORDER, exempt=True) == 0.0
    assert tax_due(ORDER, exempt=False) == 0.66
