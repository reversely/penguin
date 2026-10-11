"""Bottle deposits, charged per bottle and never taxed."""

from orders.model import Order
from shared import money

DEPOSIT_CENTS = 5


def bottle_deposit(order: Order, bottle_skus: set[str]) -> money.Money:
    """The deposit on an order: DEPOSIT_CENTS per bottle, in US dollars."""
    bottles = sum(line.quantity for line in order.lines if line.sku in bottle_skus)
    return money.price(DEPOSIT_CENTS * bottles, "USD")
