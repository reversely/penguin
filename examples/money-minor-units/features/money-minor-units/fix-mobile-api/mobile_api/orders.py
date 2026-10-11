"""Order payloads for the mobile apps."""

from orders.model import Order, order_total


def order_payload(order: Order) -> dict:
    """An order as the apps receive it: the total for display and in the minor unit."""
    total = order_total(order)
    return {
        "id": order.id,
        "currency": order.currency,
        "total": total.display(),
        "total_minor": total.amount_minor,
    }
