"""Checkout for the Japan launch: carts priced in yen."""

from checkout.cart import CartLine, charge_amount
from shared import money


def yen_line(sku: str, quantity: int, yen: int) -> CartLine:
    """A cart line priced in whole yen."""
    return CartLine(sku, quantity, money.price(yen, "JPY"))


def yen_charge(lines: list[CartLine]) -> dict:
    """The charge request for a cart priced in yen."""
    return {"amount": charge_amount(lines), "currency": "jpy"}
