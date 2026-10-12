"""Orders that ship in more than one box."""

from orders.model import Order, line_total_minor
from shared.money import Money


def shipment_total(order: Order, skus: list[str]) -> float:
    """The value of the order lines that ship together, for the courier's insurance."""
    shipped = [
        line_total_minor(line, order.currency)
        for line in order.lines
        if line.sku in skus
    ]
    return float(Money.sum(shipped).major()) if shipped else 0.0
