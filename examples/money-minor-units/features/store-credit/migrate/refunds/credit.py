"""Store credit in place of a refund to the card."""

from decimal import Decimal

from orders.model import Order
from refunds.refund import refund_amount
from shared.money import Money

BONUS_PERCENT = 10


def store_credit(order: Order, skus: list[str]) -> float:
    """Store credit for returned lines: the refund plus a bonus for taking credit, to the cent."""
    refund = Money.from_major(str(refund_amount(order, skus)), order.currency)
    return float(refund.scaled(Decimal(100 + BONUS_PERCENT) / 100).major())
