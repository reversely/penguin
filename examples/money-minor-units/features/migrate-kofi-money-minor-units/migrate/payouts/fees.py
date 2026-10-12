"""The fee Larder keeps on an order and the payout the store receives."""

from decimal import Decimal

from orders.model import Order, order_total_minor
from shared.money import Money

FEE_RATE = 0.15


def _fee(order: Order) -> Money:
    return order_total_minor(order).scaled(Decimal(repr(FEE_RATE)))


def store_fee(order: Order) -> float:
    """Larder's fee: FEE_RATE of the order total, rounded to the cent."""
    return float(_fee(order).major())


def payout(order: Order) -> float:
    """What the store receives: the order total less the fee."""
    return float((order_total_minor(order) - _fee(order)).major())
