"""Tips for the shopper, as a share of the cart."""

from decimal import Decimal

from checkout.cart import CartLine, cart_total
from shared import money


def tip(lines: list[CartLine], percent: int) -> money.Money:
    """A tip of ``percent`` per cent of the cart total, rounded to the minor unit."""
    return cart_total(lines).scaled(Decimal(percent) / 100)
