from checkout.cart import CartLine
from checkout.tips import tip
from shared.money import Money

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_tip_is_a_share_of_the_cart():
    """A tip is the chosen percentage of the cart total rounded to the cent."""
    assert tip(LINES, 10, "USD") == Money(62, "USD")
