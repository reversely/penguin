from orders.model import Line, Order
from shared.money import Money
from tax.invoice import invoice_tax, invoice_tax_minor

# Each line's tax rounds down; rounding the order's subtotal once would add a cent.
THREE_LINES = Order(
    "o-3",
    "NY",
    "USD",
    [Line("apples", 1, 1.29), Line("pears", 1, 1.74), Line("plums", 1, 1.06)],
)


def test_tax_rounded_per_line():
    """Tax is rounded per line item."""
    assert invoice_tax(THREE_LINES) == Money(35, "USD")


def test_tax_uses_the_region_rate():
    """Each order is taxed at its region's rate."""
    order = Order("o-4", "NJ", "USD", [Line("coffee", 1, 10.0)])
    assert invoice_tax(order) == Money(66, "USD")


def test_invoice_tax_minor_is_in_cents():
    """An invoice's tax in cents is rounded per line item."""
    assert invoice_tax_minor(THREE_LINES) == 35
