"""The filing period each region's sales tax is returned in."""

from datetime import date

from tax.rates import RATES

# Regions that file monthly; every other region Larder sells in files quarterly.
MONTHLY = frozenset({"NY", "CA"})


def filing_period(day: date, region: str) -> str:
    """The period a sale on ``day`` is filed in, such as ``2026-03`` or ``2026-Q1``."""
    if region not in RATES:
        raise KeyError(region)
    if region in MONTHLY:
        return f"{day.year}-{day.month:02d}"
    return f"{day.year}-Q{(day.month - 1) // 3 + 1}"
