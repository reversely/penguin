from checkout.cart import CartLine
from promotions.stacking import stacked_total, stacking_saving

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_coupons_stack():
    assert stacked_total(LINES, ["WELCOME10", "FRESH5"]) == 5.33


def test_saving_is_what_the_coupons_take_off():
    assert stacking_saving(LINES, ["WELCOME10", "FRESH5"]) == 0.9
