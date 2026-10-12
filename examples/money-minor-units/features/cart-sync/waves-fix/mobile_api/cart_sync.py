"""Keeping the cart the same on phone and web."""

from checkout.cart import CartLine, cart_total


def cart_payload(lines: list[CartLine], currency: str) -> dict:
    """The cart as the apps sync it."""
    total = cart_total(lines, currency)
    return {
        "items": [line.sku for line in lines],
        "total": total.display(),
        "total_minor": total.amount_minor,
    }
