"""Orders and their lines, built from the order store's records."""

from __future__ import annotations

from dataclasses import dataclass

from shared.money import Money


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


def line_total_minor(line: Line, currency: str) -> Money:
    """A line's price times its quantity in ``currency``, whose major units the stored price holds."""
    return Money.from_major(str(line.unit_price), currency).times(line.quantity)


def order_total_minor(order: Order) -> Money:
    """The sum of an order's line totals, in the order's currency."""
    return Money.sum([line_total_minor(line, order.currency) for line in order.lines])
