"""Several coupons on one cart, each taken off what the one before left."""

from checkout.cart import CartLine, cart_total
from promotions.coupons import coupon_percent
from shared.money import Money
from shared.money.discounts import discounted


def stacked_total(lines: list[CartLine], codes: list[str]) -> float:
    """The cart total after every coupon."""
    total = Money.from_major(str(cart_total(lines)), "USD")
    percents = [coupon_percent(code) for code in codes]
    return float(discounted(total, *percents).major())


def stacking_saving(lines: list[CartLine], codes: list[str]) -> float:
    """How much the coupons save together, in dollars."""
    return round(cart_total(lines) - stacked_total(lines, codes), 2)
