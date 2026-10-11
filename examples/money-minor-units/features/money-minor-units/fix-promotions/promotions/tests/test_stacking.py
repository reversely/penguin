from checkout.cart import CartLine
from promotions.stacking import stacked_total, stacking_saving
from shared.money import Money

LINES = [
    CartLine("milk", 2, Money(149, "USD")),
    CartLine("bread", 1, Money(325, "USD")),
]


def test_coupons_stack():
    """Each stacked coupon comes off what the coupon before it left."""
    assert stacked_total(LINES, ["WELCOME10", "FRESH5"]) == Money(533, "USD")


def test_saving_is_what_the_coupons_take_off():
    """The saving from stacked coupons is what they take off the cart total."""
    assert stacking_saving(LINES, ["WELCOME10", "FRESH5"]) == Money(90, "USD")
