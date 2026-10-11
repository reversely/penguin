"""Ordering a past order again."""

from orders.model import Order
from shared import money


def reorder_estimate(order: Order, shelf_prices: dict[str, float]) -> float:
    """What the same order costs at today's shelf prices."""
    return money.total(
        [money.price(shelf_prices[line.sku] * line.quantity) for line in order.lines]
    )
