"""The receipt a customer receives after paying."""

from orders.model import Order, line_total_minor, order_total_minor


def receipt_text(order: Order) -> str:
    """The receipt's text: each line with its total, then the amount paid."""
    rows = [
        f"{line.sku} {line_total_minor(line, order.currency).display()}"
        for line in order.lines
    ]
    paid = order_total_minor(order).display()
    return "\n".join([f"Receipt for order {order.id}", *rows, f"Paid {paid}"])
