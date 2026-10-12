"""The amount refunded for returned order lines."""

from orders.model import Order, line_total_minor
from shared.money import Money


def _refund(order: Order, skus: list[str]) -> Money:
    returned = [
        line_total_minor(line, order.currency)
        for line in order.lines
        if line.sku in skus
    ]
    return Money.sum(returned) if returned else Money(0, order.currency)


def refund_amount(order: Order, skus: list[str]) -> float:
    """The refund for the order's lines with these SKUs, in dollars."""
    return float(_refund(order, skus).major())


def refund_cents(order: Order, skus: list[str]) -> int:
    """The refund sent to the card processor, in cents."""
    return _refund(order, skus).amount_minor
