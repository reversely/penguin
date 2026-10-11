"""Orders that ship in more than one box."""

from orders.model import Order, line_total
from shared import money


def shipment_total(order: Order, skus: list[str]) -> float:
    """The value of the order lines that ship together, for the courier's insurance."""
    return money.total([line_total(line) for line in order.lines if line.sku in skus])
