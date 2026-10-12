"""Discounts on prices."""

from decimal import Decimal

from shared.money import Money


def discounted(amount: Money, *percents: int) -> Money:
    """The amount after taking each percentage off in turn, rounded to the minor unit once at the end."""
    factor = Decimal(1)
    for percent in percents:
        factor = factor * (100 - percent) / 100
    return amount.scaled(factor)
