"""The cart total and the amount charged to the card."""

from dataclasses import dataclass

from shared import money


@dataclass(frozen=True)
class CartLine:
    sku: str
    quantity: int
    unit_price: float


def cart_total(lines: list[CartLine]) -> float:
    """The cart's total in dollars: each line's price times its quantity, rounded to the cent."""
    return money.total([money.price(line.unit_price * line.quantity) for line in lines])


def charge_amount(lines: list[CartLine]) -> int:
    """The amount sent to the card processor, in cents."""
    return round(cart_total(lines) * 100)


def total_line(lines: list[CartLine]) -> str:
    """The total as the checkout page shows it."""
    return f"Total {money.display(cart_total(lines))}"
