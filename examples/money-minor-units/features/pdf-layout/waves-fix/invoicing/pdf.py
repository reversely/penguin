"""The column layout of the PDF invoice."""

from orders.model import Order, line_total_minor


def amount_column(order: Order, width: int = 10) -> list[str]:
    """Each line's amount, right-aligned in a column ``width`` characters wide."""
    return [
        line_total_minor(line, order.currency).display().rjust(width)
        for line in order.lines
    ]
