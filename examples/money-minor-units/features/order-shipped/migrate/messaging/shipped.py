"""The email sent when an order leaves the store."""

from orders.model import Order, order_total_minor


def shipped_email(order: Order) -> str:
    """The email's text."""
    total = order_total_minor(order).display()
    return f"Your order {order.id} is on its way. Total {total}."
