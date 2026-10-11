"""Prices in dollars as floats, and the arithmetic every scope uses on them."""

from decimal import Decimal

from shared.money.rounding import ROUNDING

CENT = Decimal("0.01")


def price(amount: float) -> float:
    """Round an amount in dollars to the cent."""
    return float(Decimal(repr(float(amount))).quantize(CENT, rounding=ROUNDING))


def total(prices: list[float]) -> float:
    """Sum amounts in dollars and round the sum to the cent."""
    return price(sum(prices))


def display(amount: float) -> str:
    """Format an amount in dollars for a person to read, such as ``$1,234.50``."""
    return f"${amount:,.2f}"
