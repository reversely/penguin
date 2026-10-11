from checkout.cart import CartLine, cart_total, charge_amount, total_line

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_cart_total_sums_each_line():
    assert cart_total(LINES) == 6.23


def test_charge_amount_is_in_cents():
    assert charge_amount(LINES) == 623


def test_total_line_shows_the_total():
    assert total_line(LINES) == "Total $6.23"
