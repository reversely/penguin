"""Keeping the cart the same on phone and web."""

from checkout.cart import CartLine, cart_total
from shared import money


def cart_payload(lines: list[CartLine]) -> dict:
    """The cart as the apps sync it."""
    total = cart_total(lines)
    return {
        "items": [line.sku for line in lines],
        "total": money.display(total),
        "total_minor": round(total * 100),
    }
