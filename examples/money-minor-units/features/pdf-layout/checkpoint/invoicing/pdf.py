"""The column layout of the PDF invoice."""

from orders.model import Order, line_total
from shared import money


def amount_column(order: Order, width: int = 10) -> list[str]:
    """Each line's amount, right-aligned in a column ``width`` characters wide."""
    return [money.display(line_total(line)).rjust(width) for line in order.lines]
