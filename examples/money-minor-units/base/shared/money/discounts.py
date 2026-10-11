"""Discounts on prices in dollars."""

from decimal import Decimal

from shared.money.rounding import ROUNDING

CENT = Decimal("0.01")


def percent_off(amount: float, percent: int) -> float:
    """The amount after taking ``percent`` per cent off, rounded to the cent."""
    kept = Decimal(repr(float(amount))) * (100 - percent) / 100
    return float(kept.quantize(CENT, rounding=ROUNDING))
