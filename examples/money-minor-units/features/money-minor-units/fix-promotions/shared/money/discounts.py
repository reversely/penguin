"""Discounts on prices."""

from decimal import Decimal

from shared import money


def percent_off(amount: money.Money, *percents: int) -> money.Money:
    """The amount after taking each percentage off in turn, rounded to the minor unit once."""
    kept = Decimal(1)
    for percent in percents:
        kept = kept * (100 - percent) / 100
    return amount.scaled(kept)
