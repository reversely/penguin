"""The size of the average basket."""

from decimal import Decimal

from orders.model import Order, order_total_minor
from shared.money import Money


def average_basket(orders: list[Order]) -> float:
    """The mean order total, rounded to the cent."""
    total = Money.sum([order_total_minor(order) for order in orders])
    return float(total.scaled(Decimal(1) / len(orders)).major())
