"""Checkout for the Japan launch: carts priced in yen."""

from checkout.cart import CartLine
from shared.money import Money


def yen_line(sku: str, quantity: int, yen: int) -> CartLine:
    """A cart line priced in whole yen."""
    return CartLine(sku, quantity, float(yen))


def yen_charge(lines: list[CartLine]) -> dict:
    """The charge request for a cart priced in yen, which has no minor unit."""
    total = Money.sum(
        [
            Money.from_major(str(line.unit_price), "JPY").times(line.quantity)
            for line in lines
        ]
    )
    return {"amount": total.amount_minor, "currency": "jpy"}
