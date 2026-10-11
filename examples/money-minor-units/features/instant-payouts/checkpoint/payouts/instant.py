"""Instant payouts, for a flat fee."""

from orders.model import Order
from payouts.fees import payout
from shared import money

INSTANT_FEE = 0.5


def instant_payout(order: Order) -> float:
    """The payout sent at once: the usual payout less INSTANT_FEE dollars."""
    return money.price(payout(order) - INSTANT_FEE)
