"""Discounts on prices: the float API in dollars, and the same on Money."""

from decimal import Decimal

from shared.money import Money
from shared.money.rounding import ROUNDING

CENT = Decimal("0.01")


def percent_off(amount: float, *percents: int) -> float:
    """The amount after taking each percentage off in turn, rounded to the cent once at the end."""
    kept = Decimal(repr(float(amount)))
    for percent in percents:
        kept = kept * (100 - percent) / 100
    return float(kept.quantize(CENT, rounding=ROUNDING))


def discounted(amount: Money, *percents: int) -> Money:
    """The amount after taking each percentage off in turn, rounded to the minor unit once at the end."""
    factor = Decimal(1)
    for percent in percents:
        factor = factor * (100 - percent) / 100
    return amount.scaled(factor)
