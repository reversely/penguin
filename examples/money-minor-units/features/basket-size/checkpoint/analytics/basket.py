"""The size of the average basket."""

from orders.model import Order, order_total
from shared import money


def average_basket(orders: list[Order]) -> float:
    """The mean order total, rounded to the cent."""
    return money.price(
        money.total([order_total(order) for order in orders]) / len(orders)
    )
