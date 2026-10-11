"""The receipt a customer receives after paying."""

from orders.model import Order, line_total, order_total
from shared import money


def receipt_text(order: Order) -> str:
    """The receipt's text: each line with its total, then the amount paid."""
    rows = [f"{line.sku} {money.display(line_total(line))}" for line in order.lines]
    paid = money.display(order_total(order))
    return "\n".join([f"Receipt for order {order.id}", *rows, f"Paid {paid}"])
