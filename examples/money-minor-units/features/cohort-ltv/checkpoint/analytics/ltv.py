"""Lifetime value per customer."""

from orders.model import Order, order_total
from shared import money


def lifetime_value(orders_by_customer: dict[str, list[Order]]) -> dict[str, float]:
    """Each customer's spend over every order they placed."""
    return {
        customer: money.total([order_total(order) for order in orders])
        for customer, orders in sorted(orders_by_customer.items())
    }
