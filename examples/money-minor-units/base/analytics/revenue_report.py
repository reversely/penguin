"""Daily revenue for the finance report."""

from orders.model import Order, order_total
from shared import money


def revenue_by_day(orders_by_day: dict[str, list[Order]]) -> dict[str, float]:
    """Each day's revenue: the sum of that day's order totals, in dollars."""
    return {
        day: money.total([order_total(order) for order in orders])
        for day, orders in sorted(orders_by_day.items())
    }


def report_lines(orders_by_day: dict[str, list[Order]]) -> list[str]:
    """One line per day for the finance report."""
    revenue = revenue_by_day(orders_by_day)
    return [f"{day}: {money.display(amount)}" for day, amount in revenue.items()]
