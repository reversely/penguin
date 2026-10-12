"""Instant payouts, for a flat fee."""

from orders.model import Order
from payouts.fees import payout
from shared.money import Money

INSTANT_FEE = 0.5


def instant_payout(order: Order) -> float:
    """The payout sent at once: the usual payout less INSTANT_FEE dollars."""
    usual = Money.from_major(str(payout(order)), order.currency)
    fee = Money.from_major(str(INSTANT_FEE), order.currency)
    return float((usual - fee).major())
