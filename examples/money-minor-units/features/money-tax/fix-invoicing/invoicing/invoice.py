"""The invoice of an order: its lines, the tax and the total due."""

from orders.model import Order, line_total_minor, order_total_minor
from shared.money import Money
from tax.invoice import invoice_tax


def amount_due(order: Order) -> Money:
    """The order total plus its tax."""
    return Money.sum([order_total_minor(order), invoice_tax(order)])


def render_invoice(order: Order) -> list[str]:
    """The invoice's rows: one per order line, then the tax and the total due."""
    rows = [
        f"{line.quantity} x {line.sku}: {line_total_minor(line, order.currency).display()}"
        for line in order.lines
    ]
    tax = invoice_tax(order).display()
    return [*rows, f"Tax: {tax}", f"Total due: {amount_due(order).display()}"]


def amount_due_cents(order: Order) -> int:
    """The total due in the currency's minor unit, which must equal the card charge."""
    return amount_due(order).amount_minor
