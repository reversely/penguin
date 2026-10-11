"""Sales tax rates by region."""

from decimal import Decimal

RATES = {
    "NY": Decimal("0.08875"),
    "NJ": Decimal("0.06625"),
    "CA": Decimal("0.0725"),
    "WA": Decimal("0.065"),
}


def rate_for(region: str) -> Decimal:
    """The sales tax rate of a region."""
    return RATES[region]
