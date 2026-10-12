"""Ordering a past order again."""

from orders.model import Order
from shared.money import Money


def reorder_estimate(order: Order, shelf_prices: dict[str, float]) -> float:
    """What the same order costs at today's shelf prices."""
    lines = [
        Money.from_major(str(shelf_prices[line.sku]), order.currency).times(
            line.quantity
        )
        for line in order.lines
    ]
    return float(Money.sum(lines).major())
