from datetime import date

import pytest

from tax_filing.periods import filing_period


def test_monthly_and_quarterly_regions():
    assert filing_period(date(2026, 3, 9), "NY") == "2026-03"
    assert filing_period(date(2026, 3, 9), "WA") == "2026-Q1"


def test_a_region_without_a_rate_has_no_period():
    with pytest.raises(KeyError):
        filing_period(date(2026, 3, 9), "TX")
