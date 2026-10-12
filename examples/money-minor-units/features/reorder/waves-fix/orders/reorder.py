"""Ordering a past order again."""

from orders.model import Order
from shared.money import Money


def reorder_estimate(order: Order, shelf_prices: dict[str, Money]) -> Money:
    """What the same order costs at today's shelf prices."""
    return Money.sum(
        [shelf_prices[line.sku].times(line.quantity) for line in order.lines]
    )
