"""Tips for the shopper, as a share of the cart."""

from decimal import Decimal

from checkout.cart import CartLine, cart_total
from shared.money import Money


def tip(lines: list[CartLine], percent: int) -> float:
    """A tip of ``percent`` per cent of the cart total, rounded to the cent."""
    total = Money.from_major(str(cart_total(lines)), "USD")
    return float(total.scaled(Decimal(percent) / 100).major())
