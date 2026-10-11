"""The fee Larder keeps on an order and the payout the store receives."""

from orders.model import Order, order_total
from shared import money

FEE_RATE = 0.15


def store_fee(order: Order) -> float:
    """Larder's fee: FEE_RATE of the order total, rounded to the cent."""
    return money.price(order_total(order) * FEE_RATE)


def payout(order: Order) -> float:
    """What the store receives: the order total less the fee."""
    return money.price(order_total(order) - store_fee(order))
