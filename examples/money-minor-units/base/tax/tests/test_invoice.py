from orders.model import Line, Order
from tax.invoice import invoice_tax, invoice_tax_minor

# Each line's tax rounds down; rounding the order's subtotal once would add a cent.
THREE_LINES = Order(
    "o-3",
    "NY",
    "USD",
    [Line("apples", 1, 1.29), Line("pears", 1, 1.74), Line("plums", 1, 1.06)],
)


def test_tax_rounded_per_line():
    assert invoice_tax(THREE_LINES) == 0.35


def test_tax_uses_the_region_rate():
    assert invoice_tax(Order("o-4", "NJ", "USD", [Line("coffee", 1, 10.0)])) == 0.66


def test_invoice_tax_minor_is_in_cents():
    assert invoice_tax_minor(THREE_LINES) == 35
