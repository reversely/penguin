from shared.currencies.table import is_supported, minor_digits


def test_yen_has_no_minor_unit():
    assert minor_digits("JPY") == 0
    assert minor_digits("usd") == 2


def test_unknown_currency_is_not_supported():
    assert not is_supported("XYZ")
