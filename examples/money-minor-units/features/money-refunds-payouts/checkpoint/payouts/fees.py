"""The fee Larder keeps on an order and the payout the store receives."""

from decimal import ROUND_HALF_UP, Decimal

from orders.model import Order, order_total_minor
from shared.money import Money

FEE_RATE = Decimal("0.15")


def store_fee(order: Order) -> Money:
    """Larder's fee: FEE_RATE of the order total, rounded half up to the minor unit.

    The rounding is fixed here, not taken from the shared rounding mode: the store agreement says
    half up. The float version rounded some ties down, because 4.30 * 0.15 is 0.64499... in binary.
    """
    total = order_total_minor(order)
    fee = (Decimal(total.amount_minor) * FEE_RATE).quantize(
        Decimal(1), rounding=ROUND_HALF_UP
    )
    return Money(int(fee), total.currency)


def payout(order: Order) -> Money:
    """What the store receives: the order total less the fee."""
    return order_total_minor(order) - store_fee(order)
