"""The invoice of an order: its lines, the tax and the total due."""

from orders.model import Order, line_total_minor, order_total_minor
from shared.money import Money
from tax.invoice import invoice_tax_minor


def _due(order: Order) -> Money:
    return order_total_minor(order) + Money(invoice_tax_minor(order), order.currency)


def amount_due(order: Order) -> float:
    """The order total plus its tax, in dollars."""
    return float(_due(order).major())


def render_invoice(order: Order) -> list[str]:
    """The invoice's rows: one per order line, then the tax and the total due."""
    rows = [
        f"{line.quantity} x {line.sku}: {line_total_minor(line, order.currency).display()}"
        for line in order.lines
    ]
    tax = Money(invoice_tax_minor(order), order.currency).display()
    return [*rows, f"Tax: {tax}", f"Total due: {_due(order).display()}"]


def amount_due_cents(order: Order) -> int:
    """The total due in cents, which must equal the card charge."""
    return _due(order).amount_minor
