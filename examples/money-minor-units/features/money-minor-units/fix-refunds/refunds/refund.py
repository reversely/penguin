"""The amount refunded for returned order lines."""

from orders.model import Order, line_total
from shared import money


def refund_amount(order: Order, skus: list[str]) -> money.Money:
    """The refund for the order's lines with these SKUs."""
    return money.total([line_total(line) for line in order.lines if line.sku in skus])


def refund_cents(order: Order, skus: list[str]) -> int:
    """The refund sent to the card processor, in the currency's minor unit."""
    return refund_amount(order, skus).amount_minor
