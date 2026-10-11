"""The invoice of an order: its lines, the tax and the total due."""

from orders.model import Order, line_total, order_total
from shared import money
from tax.invoice import invoice_tax


def amount_due(order: Order) -> float:
    """The order total plus its tax, in dollars."""
    return money.total([order_total(order), invoice_tax(order)])


def render_invoice(order: Order) -> list[str]:
    """The invoice's rows: one per order line, then the tax and the total due."""
    rows = [
        f"{line.quantity} x {line.sku}: {money.display(line_total(line))}"
        for line in order.lines
    ]
    tax = money.display(invoice_tax(order))
    return [*rows, f"Tax: {tax}", f"Total due: {money.display(amount_due(order))}"]


def amount_due_cents(order: Order) -> int:
    """The total due in cents, which must equal the card charge."""
    return round(amount_due(order) * 100)
