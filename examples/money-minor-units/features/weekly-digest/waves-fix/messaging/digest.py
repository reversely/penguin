"""The weekly digest email of a customer's orders."""

from orders.model import Order, order_total_minor
from shared.money import Money


def digest(orders: list[Order]) -> str:
    """The digest's headline."""
    spent = Money.sum([order_total_minor(order) for order in orders])
    return f"{len(orders)} orders this week, {spent.display()} in all."
