"""The cart total and the amount charged to the card."""

from dataclasses import dataclass

from shared.money import Money


@dataclass(frozen=True)
class CartLine:
    sku: str
    quantity: int
    unit_price: float


def _cart(lines: list[CartLine]) -> Money:
    """The cart's total in US cents: each line's price times its quantity."""
    totals = [
        Money.from_major(str(line.unit_price), "USD").times(line.quantity)
        for line in lines
    ]
    return Money.sum(totals) if totals else Money(0, "USD")


def cart_total(lines: list[CartLine]) -> float:
    """The cart's total in dollars: each line's price times its quantity, rounded to the cent."""
    return float(_cart(lines).major())


def charge_amount(lines: list[CartLine]) -> int:
    """The amount sent to the card processor, in cents."""
    return _cart(lines).amount_minor


def total_line(lines: list[CartLine]) -> str:
    """The total as the checkout page shows it."""
    return f"Total {_cart(lines).display()}"
