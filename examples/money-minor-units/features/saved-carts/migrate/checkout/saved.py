"""Carts a customer saves to order again."""

from checkout.cart import CartLine, cart_total
from shared.money import Money


def saved_cart_summary(name: str, lines: list[CartLine]) -> str:
    """A saved cart as the list of saved carts shows it."""
    count = sum(line.quantity for line in lines)
    total = Money.from_major(str(cart_total(lines)), "USD")
    return f"{name}: {count} items, {total.display()}"
