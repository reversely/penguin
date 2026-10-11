"""A customer's past orders for the apps."""

from orders.model import Order, order_total


def history_payload(orders: list[Order]) -> list[dict]:
    """Each past order with its total for display."""
    return [{"id": order.id, "total": order_total(order).display()} for order in orders]
