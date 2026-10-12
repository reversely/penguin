from analytics.revenue_report import report_lines, revenue_by_day
from orders.model import Line, Order
from shared.money import Money

DAYS = {
    "2026-03-02": [
        Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
        Order("o-2", "CA", "USD", [Line("eggs", 1, 4.1)]),
    ],
    "2026-03-01": [Order("o-0", "WA", "USD", [Line("rice", 3, 2.0)])],
}


def test_revenue_sums_each_days_orders():
    """Daily revenue equals the sum of that day's order totals."""
    assert revenue_by_day(DAYS) == {
        "2026-03-01": {"USD": Money(600, "USD")},
        "2026-03-02": {"USD": Money(1033, "USD")},
    }


def test_report_has_one_line_per_day_in_order():
    """The revenue report shows one line per day in date order."""
    assert report_lines(DAYS) == ["2026-03-01: $6.00", "2026-03-02: $10.33"]


def test_currencies_are_reported_separately():
    day = {
        "2026-03-03": [
            Order("o-7", "NY", "USD", [Line("milk", 1, 1.49)]),
            Order("o-8", "TK", "JPY", [Line("onigiri", 2, 150.0)]),
        ]
    }
    assert report_lines(day) == ["2026-03-03: ¥300, $1.49"]
