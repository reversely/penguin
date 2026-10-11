from store_dashboard.holidays import is_closed


def test_store_is_closed_on_its_holidays():
    assert is_closed("2026-12-25", {"2026-12-25", "2027-01-01"})
    assert not is_closed("2026-12-24", {"2026-12-25"})
