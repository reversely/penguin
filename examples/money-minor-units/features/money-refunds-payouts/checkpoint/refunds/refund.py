"""The amount refunded for returned order lines."""

from orders.model import Order, line_total_minor
from shared.money import Money


def refund_amount(order: Order, skus: list[str]) -> Money:
    """The refund for the order's lines with these SKUs."""
    return Money.sum(
        [
            line_total_minor(line, order.currency)
            for line in order.lines
            if line.sku in skus
        ]
    )


def refund_cents(order: Order, skus: list[str]) -> int:
    """The refund sent to the card processor, in the currency's minor unit."""
    return refund_amount(order, skus).amount_minor
