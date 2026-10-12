"""Refunds for some of the units on one line."""

from orders.model import Order
from shared.money import Money


def partial_refund(order: Order, sku: str, quantity: int) -> float:
    """The refund for returning ``quantity`` units of one line, never more than were bought."""
    line = next(line for line in order.lines if line.sku == sku)
    unit = Money.from_major(str(line.unit_price), order.currency)
    return float(unit.times(min(quantity, line.quantity)).major())
