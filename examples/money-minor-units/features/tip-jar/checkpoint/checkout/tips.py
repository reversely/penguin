"""Tips for the shopper, as a share of the cart."""

from checkout.cart import CartLine, cart_total
from shared import money


def tip(lines: list[CartLine], percent: int) -> float:
    """A tip of ``percent`` per cent of the cart total, rounded to the cent."""
    return money.price(cart_total(lines) * percent / 100)
