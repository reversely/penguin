"""Order payloads for the mobile apps."""

from orders.model import Order, order_total
from shared import money


def order_payload(order: Order) -> dict:
    """An order as the apps receive it: the total for display and in the minor unit."""
    total = order_total(order)
    return {
        "id": order.id,
        "currency": order.currency,
        "total": money.display(total),
        "total_minor": round(total * 100),
    }
