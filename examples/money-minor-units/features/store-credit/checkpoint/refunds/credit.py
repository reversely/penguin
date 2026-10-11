"""Store credit in place of a refund to the card."""

from orders.model import Order
from refunds.refund import refund_amount
from shared import money

BONUS_PERCENT = 10


def store_credit(order: Order, skus: list[str]) -> float:
    """Store credit for returned lines: the refund plus a bonus for taking credit, to the cent."""
    return money.price(refund_amount(order, skus) * (100 + BONUS_PERCENT) / 100)
