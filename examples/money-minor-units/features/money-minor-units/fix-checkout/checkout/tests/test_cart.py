from checkout.cart import CartLine, cart_total, charge_amount, total_line
from shared.money import Money

LINES = [
    CartLine("milk", 2, Money(149, "USD")),
    CartLine("bread", 1, Money(325, "USD")),
]


def test_cart_total_sums_each_line():
    """The cart total is the sum of its line totals."""
    assert cart_total(LINES) == Money(623, "USD")


def test_charge_amount_is_in_cents():
    """The card charge equals the cart total."""
    assert charge_amount(LINES) == 623


def test_total_line_shows_the_total():
    """The cart's total line shows the cart total."""
    assert total_line(LINES) == "Total $6.23"
