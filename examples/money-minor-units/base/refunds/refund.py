"""The amount refunded for returned order lines."""

from orders.model import Order, line_total
from shared import money


def refund_amount(order: Order, skus: list[str]) -> float:
    """The refund for the order's lines with these SKUs, in dollars."""
    return money.total([line_total(line) for line in order.lines if line.sku in skus])


def refund_cents(order: Order, skus: list[str]) -> int:
    """The refund sent to the card processor, in cents."""
    return round(refund_amount(order, skus) * 100)
