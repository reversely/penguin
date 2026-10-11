"""The weekly digest email of a customer's orders."""

from orders.model import Order, order_total
from shared import money


def digest(orders: list[Order]) -> str:
    """The digest's headline."""
    spent = money.total([order_total(order) for order in orders])
    return f"{len(orders)} orders this week, {money.display(spent)} in all."
