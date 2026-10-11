"""A customer's past orders for the apps."""

from orders.model import Order, order_total
from shared import money


def history_payload(orders: list[Order]) -> list[dict]:
    """Each past order with its total for display."""
    return [
        {"id": order.id, "total": money.display(order_total(order))} for order in orders
    ]
