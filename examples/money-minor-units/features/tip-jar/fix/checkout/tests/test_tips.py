from checkout.cart import CartLine
from checkout.tips import tip
from shared.money import Money

LINES = [
    CartLine("milk", 2, Money(149, "USD")),
    CartLine("bread", 1, Money(325, "USD")),
]


def test_tip_is_a_share_of_the_cart():
    """A tip is the chosen percentage of the cart total rounded to the cent."""
    assert tip(LINES, 10) == Money(62, "USD")
