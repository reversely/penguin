"""Pick lists for the shoppers who fill orders in store."""

from orders.model import Order


def pick_list(order: Order) -> list[tuple[str, int]]:
    """Each SKU of the order with its quantity, in SKU order, as the shopper walks the aisles."""
    counts: dict[str, int] = {}
    for line in order.lines:
        counts[line.sku] = counts.get(line.sku, 0) + line.quantity
    return sorted(counts.items())


def slots_left(capacity: int, booked: int) -> int:
    """Delivery slots still open in a window."""
    return max(capacity - booked, 0)
