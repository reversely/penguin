"""The cart total and the amount charged to the card."""

from dataclasses import dataclass

from shared import money


@dataclass(frozen=True)
class CartLine:
    sku: str
    quantity: int
    unit_price: money.Money


def cart_total(lines: list[CartLine]) -> money.Money:
    """The cart's total: each line's price times its quantity."""
    return money.total([line.unit_price.times(line.quantity) for line in lines])


def charge_amount(lines: list[CartLine]) -> int:
    """The amount sent to the card processor, in the currency's minor unit."""
    return cart_total(lines).amount_minor


def total_line(lines: list[CartLine]) -> str:
    """The total as the checkout page shows it."""
    return f"Total {cart_total(lines).display()}"
