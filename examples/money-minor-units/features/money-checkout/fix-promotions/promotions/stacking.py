"""Several coupons on one cart, each taken off what the one before left."""

from checkout.cart import CartLine, cart_total
from promotions.coupons import coupon_percent
from shared.money import Money
from shared.money.discounts import discounted


def stacked_total(lines: list[CartLine], codes: list[str], currency: str) -> Money:
    """The cart total after every coupon."""
    return discounted(
        cart_total(lines, currency), *[coupon_percent(code) for code in codes]
    )


def stacking_saving(lines: list[CartLine], codes: list[str], currency: str) -> Money:
    """How much the coupons save together."""
    return cart_total(lines, currency) - stacked_total(lines, codes, currency)
