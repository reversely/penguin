"""The email sent when an order leaves the store."""

from orders.model import Order, order_total
from shared import money


def shipped_email(order: Order) -> str:
    """The email's text."""
    return f"Your order {order.id} is on its way. Total {money.display(order_total(order))}."
