"""Refunds for some of the units on one line."""

from orders.model import Order
from shared import money


def partial_refund(order: Order, sku: str, quantity: int) -> money.Money:
    """The refund for returning ``quantity`` units of one line, never more than were bought."""
    line = next(line for line in order.lines if line.sku == sku)
    return line.unit_price.times(min(quantity, line.quantity))
