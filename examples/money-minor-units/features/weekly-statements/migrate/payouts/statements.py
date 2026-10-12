"""Weekly payout statements for stores."""

from orders.model import Order
from payouts.fees import payout
from shared.money import Money


def _week(orders: list[Order]) -> Money:
    return Money.sum(
        [Money.from_major(str(payout(order)), order.currency) for order in orders]
    )


def weekly_payout(orders: list[Order]) -> float:
    """What a store receives for a week's orders."""
    return float(_week(orders).major())


def statement_line(store: str, orders: list[Order]) -> str:
    """The statement's headline for one store."""
    return f"{store} receives {_week(orders).display()}"
