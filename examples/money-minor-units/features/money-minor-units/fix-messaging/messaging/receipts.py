"""The receipt a customer receives after paying."""

from orders.model import Order, line_total, order_total


def receipt_text(order: Order) -> str:
    """The receipt's text: each line with its total, then the amount paid."""
    rows = [f"{line.sku} {line_total(line).display()}" for line in order.lines]
    paid = order_total(order).display()
    return "\n".join([f"Receipt for order {order.id}", *rows, f"Paid {paid}"])
