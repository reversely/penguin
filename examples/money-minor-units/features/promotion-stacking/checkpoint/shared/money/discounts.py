"""Discounts on prices in dollars."""

from decimal import Decimal

from shared.money.rounding import ROUNDING

CENT = Decimal("0.01")


def percent_off(amount: float, *percents: int) -> float:
    """The amount after taking each percentage off in turn, rounded to the cent once at the end."""
    kept = Decimal(repr(float(amount)))
    for percent in percents:
        kept = kept * (100 - percent) / 100
    return float(kept.quantize(CENT, rounding=ROUNDING))
