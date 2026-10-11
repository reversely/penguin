"""Instant payouts, for a flat fee."""

from orders.model import Order
from payouts.fees import payout
from shared import money

INSTANT_FEE_MINOR = 50


def instant_payout(order: Order) -> money.Money:
    """The payout sent at once: the usual payout less INSTANT_FEE_MINOR in the order's currency."""
    return payout(order) - money.price(INSTANT_FEE_MINOR, order.currency)
