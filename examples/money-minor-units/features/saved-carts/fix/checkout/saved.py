"""Carts a customer saves to order again."""

from checkout.cart import CartLine, cart_total


def saved_cart_summary(name: str, lines: list[CartLine]) -> str:
    """A saved cart as the list of saved carts shows it."""
    count = sum(line.quantity for line in lines)
    return f"{name}: {count} items, {cart_total(lines).display()}"
