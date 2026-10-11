from checkout.japan import yen_charge, yen_line


def test_charge_names_the_currency():
    """A charge names the currency of its cart."""
    assert yen_charge([yen_line("onigiri", 2, 150)])["currency"] == "jpy"


def test_yen_charged_at_face_value():
    """The card charge equals the cart total."""
    # The yen has no minor unit: 300 yen is charged as 300, never as 30000.
    assert yen_charge([yen_line("onigiri", 2, 150)]) == {
        "amount": 300,
        "currency": "jpy",
    }
