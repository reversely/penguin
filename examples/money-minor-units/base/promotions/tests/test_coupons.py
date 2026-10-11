from promotions.coupons import coupon_percent


def test_coupon_codes_ignore_case_and_spaces():
    assert coupon_percent(" welcome10 ") == 10


def test_unknown_codes_take_nothing_off():
    assert coupon_percent("FREE100") == 0
