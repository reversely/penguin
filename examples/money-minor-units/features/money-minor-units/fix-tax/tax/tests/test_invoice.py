from orders.model import Line, Order
from shared.money import Money
from tax.invoice import invoice_tax, invoice_tax_minor

# Each line's tax rounds down; rounding the order's subtotal once would add a cent.
THREE_LINES = Order(
    "o-3",
    "NY",
    "USD",
    [
        Line("apples", 1, Money(129, "USD")),
        Line("pears", 1, Money(174, "USD")),
        Line("plums", 1, Money(106, "USD")),
    ],
)


def test_tax_rounded_per_line():
    assert invoice_tax(THREE_LINES) == Money(35, "USD")


def test_tax_uses_the_region_rate():
    order = Order("o-4", "NJ", "USD", [Line("coffee", 1, Money(1000, "USD"))])
    assert invoice_tax(order) == Money(66, "USD")


def test_invoice_tax_minor_is_in_cents():
    assert invoice_tax_minor(THREE_LINES) == 35
