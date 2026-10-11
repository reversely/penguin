"""The size of the average basket."""

from decimal import Decimal

from orders.model import Order, order_total
from shared import money


def average_basket(orders: list[Order]) -> money.Money:
    """The mean order total, rounded to the minor unit; the orders share one currency."""
    revenue = money.total([order_total(order) for order in orders])
    return revenue.scaled(Decimal(1) / len(orders))
