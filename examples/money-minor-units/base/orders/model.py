"""Orders and their lines, built from the order store's records."""

from __future__ import annotations

from dataclasses import dataclass

from shared import money


@dataclass(frozen=True)
class Line:
    sku: str
    quantity: int
    unit_price: float


@dataclass(frozen=True)
class Order:
    id: str
    region: str
    currency: str
    lines: list[Line]

    @classmethod
    def from_record(cls, record: dict) -> Order:
        """Build an order from its stored record, where each line's ``unit_price`` is in dollars."""
        lines = [
            Line(line["sku"], line["quantity"], float(line["unit_price"]))
            for line in record["lines"]
        ]
        return cls(record["id"], record["region"], record["currency"], lines)


def line_total(line: Line) -> float:
    """A line's price times its quantity, rounded to the cent."""
    return money.price(line.unit_price * line.quantity)


def order_total(order: Order) -> float:
    """The sum of an order's line totals."""
    return money.total([line_total(line) for line in order.lines])
