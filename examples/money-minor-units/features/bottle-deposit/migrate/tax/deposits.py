"""Bottle deposits, charged per bottle and never taxed."""

from orders.model import Order
from shared.money import Money

DEPOSIT = 0.05


def bottle_deposit(order: Order, bottle_skus: set[str]) -> float:
    """The deposit on an order: DEPOSIT dollars per bottle."""
    bottles = sum(line.quantity for line in order.lines if line.sku in bottle_skus)
    return float(Money.from_major(str(DEPOSIT), order.currency).times(bottles).major())
