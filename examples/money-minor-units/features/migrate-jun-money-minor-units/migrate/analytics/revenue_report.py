"""Daily revenue for the finance report."""

from orders.model import Order, order_total_minor
from shared.money import Money


def _revenue(orders: list[Order]) -> Money:
    """A day's revenue; amounts in different currencies are never added together."""
    return Money.sum([order_total_minor(order) for order in orders])


def revenue_by_day(orders_by_day: dict[str, list[Order]]) -> dict[str, float]:
    """Each day's revenue: the sum of that day's order totals, in dollars."""
    return {
        day: float(_revenue(orders).major())
        for day, orders in sorted(orders_by_day.items())
    }


def report_lines(orders_by_day: dict[str, list[Order]]) -> list[str]:
    """One line per day for the finance report."""
    return [
        f"{day}: {_revenue(orders).display()}"
        for day, orders in sorted(orders_by_day.items())
    ]
