"""Several coupons on one cart, each taken off what the one before left."""

from checkout.cart import CartLine, cart_total
from promotions.coupons import coupon_percent
from shared import money
from shared.money.discounts import percent_off


def stacked_total(lines: list[CartLine], codes: list[str]) -> money.Money:
    """The cart total after every coupon."""
    return percent_off(cart_total(lines), *[coupon_percent(code) for code in codes])


def stacking_saving(lines: list[CartLine], codes: list[str]) -> money.Money:
    """How much the coupons save together."""
    return cart_total(lines) - stacked_total(lines, codes)
