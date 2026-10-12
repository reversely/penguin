"""The size of the average basket."""

from decimal import Decimal

from orders.model import Order, order_total_minor
from shared.money import Money


def average_basket(orders: list[Order]) -> Money:
    """The mean order total, rounded to the minor unit; the orders share one currency."""
    revenue = Money.sum([order_total_minor(order) for order in orders])
    return revenue.scaled(Decimal(1) / len(orders))
