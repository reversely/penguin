"""An order's lines, page by page, for orders too long for one screen."""

from orders.model import Order, line_total_minor
from shared.platform.pagination import page


def order_lines_page(order: Order, cursor: int, limit: int = 20) -> dict:
    """One page of an order's lines, each with its price, and the next page's cursor."""
    lines, next_cursor = page(order.lines, cursor, limit)
    items = [
        {"sku": line.sku, "price": line_total_minor(line, order.currency).display()}
        for line in lines
    ]
    return {"lines": items, "next": next_cursor}
