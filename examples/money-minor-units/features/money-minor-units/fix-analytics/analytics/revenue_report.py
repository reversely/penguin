"""Daily revenue for the finance report."""

from orders.model import Order, order_total
from shared import money


def revenue_by_day(
    orders_by_day: dict[str, list[Order]],
) -> dict[str, dict[str, money.Money]]:
    """Each day's revenue in each currency. Amounts in different currencies are never added."""
    report = {}
    for day, orders in sorted(orders_by_day.items()):
        totals: dict[str, list[money.Money]] = {}
        for order in orders:
            totals.setdefault(order.currency, []).append(order_total(order))
        report[day] = {
            currency: money.total(amounts)
            for currency, amounts in sorted(totals.items())
        }
    return report


def report_lines(orders_by_day: dict[str, list[Order]]) -> list[str]:
    """One line per day for the finance report, with each currency's revenue."""
    return [
        f"{day}: {', '.join(amount.display() for amount in amounts.values())}"
        for day, amounts in revenue_by_day(orders_by_day).items()
    ]
