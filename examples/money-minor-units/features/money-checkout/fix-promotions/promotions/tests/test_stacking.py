from checkout.cart import CartLine
from promotions.stacking import stacked_total, stacking_saving
from shared.money import Money

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_coupons_stack():
    """Each stacked coupon comes off what the coupon before it left."""
    assert stacked_total(LINES, ["WELCOME10", "FRESH5"], "USD") == Money(533, "USD")


def test_saving_is_what_the_coupons_take_off():
    """The saving from stacked coupons is what they take off the cart total."""
    assert stacking_saving(LINES, ["WELCOME10", "FRESH5"], "USD") == Money(90, "USD")
