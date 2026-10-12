"""The cart total and the amount charged to the card."""

from dataclasses import dataclass

from shared.money import Money


@dataclass(frozen=True)
class CartLine:
    sku: str
    quantity: int
    unit_price: float


def cart_total(lines: list[CartLine], currency: str) -> Money:
    """The cart's total: each line's price, in ``currency``'s major units, times its quantity."""
    return Money.sum(
        [
            Money.from_major(str(line.unit_price), currency).times(line.quantity)
            for line in lines
        ]
    )


def charge_amount(lines: list[CartLine], currency: str) -> int:
    """The amount sent to the card processor, in the currency's minor unit."""
    return cart_total(lines, currency).amount_minor


def total_line(lines: list[CartLine], currency: str) -> str:
    """The total as the checkout page shows it."""
    return f"Total {cart_total(lines, currency).display()}"
