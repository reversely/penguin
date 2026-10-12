"""Lifetime value per customer."""

from orders.model import Order, order_total_minor
from shared.money import Money


def lifetime_value(orders_by_customer: dict[str, list[Order]]) -> dict[str, float]:
    """Each customer's spend over every order they placed."""
    return {
        customer: float(
            Money.sum([order_total_minor(order) for order in orders]).major()
        )
        for customer, orders in sorted(orders_by_customer.items())
    }
