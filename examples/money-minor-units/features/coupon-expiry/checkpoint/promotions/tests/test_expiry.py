from promotions.expiry import is_expired


def test_coupon_expires_after_its_last_day():
    expiries = {"FRESH5": "2026-03-31"}
    assert not is_expired("FRESH5", "2026-03-31", expiries)
    assert is_expired("FRESH5", "2026-04-01", expiries)
