"""Weekly payout statements for stores."""

from orders.model import Order
from payouts.fees import payout
from shared.money import Money


def weekly_payout(orders: list[Order]) -> Money:
    """What a store receives for a week's orders."""
    return Money.sum([payout(order) for order in orders])


def statement_line(store: str, orders: list[Order]) -> str:
    """The statement's headline for one store."""
    return f"{store} receives {weekly_payout(orders).display()}"
