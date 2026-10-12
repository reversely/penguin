"""Tips for the shopper, as a share of the cart."""

from decimal import Decimal

from checkout.cart import CartLine, cart_total
from shared.money import Money


def tip(lines: list[CartLine], percent: int, currency: str) -> Money:
    """A tip of ``percent`` per cent of the cart total, rounded to the minor unit."""
    return cart_total(lines, currency).scaled(Decimal(percent) / 100)
