"""Sales tax rates by region."""

RATES = {"NY": 0.08875, "NJ": 0.06625, "CA": 0.0725, "WA": 0.065}


def rate_for(region: str) -> float:
    """The sales tax rate of a region."""
    return RATES[region]
