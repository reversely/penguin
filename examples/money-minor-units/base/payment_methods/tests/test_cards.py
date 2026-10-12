from payment_methods.cards import is_expired, masked


def test_only_the_last_four_digits_show():
    assert masked("4242 4242 4242 4242") == "**** 4242"


def test_a_card_works_through_its_expiry_month():
    assert not is_expired(3, 2026, today_month=3, today_year=2026)
    assert is_expired(2, 2026, today_month=3, today_year=2026)
