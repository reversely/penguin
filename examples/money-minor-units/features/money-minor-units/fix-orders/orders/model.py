"""Orders and their lines, built from the order store's records."""

from __future__ import annotations

from dataclasses import dataclass

from shared import money


@dataclass(frozen=True)
class Line:
    sku: str
    quantity: int
    unit_price: money.Money


@dataclass(frozen=True)
class Order:
    id: str
    region: str
    currency: str
    lines: list[Line]

    @classmethod
    def from_record(cls, record: dict) -> Order:
        """Build an order from its stored record.

        A stored record keeps each line's ``unit_price`` in major units, such as dollars; it is read
        into the order's currency here, so stored records keep their meaning.
        """
        lines = [
            Line(
                line["sku"],
                line["quantity"],
                money.Money.from_major(str(line["unit_price"]), record["currency"]),
            )
            for line in record["lines"]
        ]
        return cls(record["id"], record["region"], record["currency"], lines)


def line_total(line: Line) -> money.Money:
    """A line's price times its quantity."""
    return line.unit_price.times(line.quantity)


def order_total(order: Order) -> money.Money:
    """The sum of an order's line totals."""
    return money.total([line_total(line) for line in order.lines])
