from invoicing.invoice import amount_due_cents, render_invoice
from orders.model import Line, Order

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_invoice_lists_each_line_then_tax_and_total():
    """An invoice lists each line, then the tax and the total due."""
    assert render_invoice(ORDER) == [
        "2 x milk: $2.98",
        "1 x bread: $3.25",
        "Tax: $0.55",
        "Total due: $6.78",
    ]


def test_amount_due_is_sent_in_cents():
    """An invoice's total due is sent in cents."""
    assert amount_due_cents(ORDER) == 678
