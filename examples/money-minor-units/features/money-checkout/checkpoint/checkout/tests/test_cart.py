from checkout.cart import CartLine, cart_total, charge_amount, total_line
from shared.money import Money

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_cart_total_sums_each_line():
    """The cart total is the sum of its line totals."""
    assert cart_total(LINES, "USD") == Money(623, "USD")


def test_charge_amount_is_in_cents():
    """The card charge equals the cart total."""
    assert charge_amount(LINES, "USD") == 623


def test_total_line_shows_the_total():
    """The cart's total line shows the cart total."""
    assert total_line(LINES, "USD") == "Total $6.23"
