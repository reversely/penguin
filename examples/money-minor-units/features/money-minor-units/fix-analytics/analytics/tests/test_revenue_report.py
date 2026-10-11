from analytics.revenue_report import report_lines, revenue_by_day
from orders.model import Line, Order
from shared.money import Money


def usd(cents: int) -> Money:
    return Money(cents, "USD")


DAYS = {
    "2026-03-02": [
        Order(
            "o-1", "NY", "USD", [Line("milk", 2, usd(149)), Line("bread", 1, usd(325))]
        ),
        Order("o-2", "CA", "USD", [Line("eggs", 1, usd(410))]),
    ],
    "2026-03-01": [Order("o-0", "WA", "USD", [Line("rice", 3, usd(200))])],
}


def test_revenue_sums_each_days_orders():
    assert revenue_by_day(DAYS) == {
        "2026-03-01": {"USD": usd(600)},
        "2026-03-02": {"USD": usd(1033)},
    }


def test_report_has_one_line_per_day_in_order():
    assert report_lines(DAYS) == ["2026-03-01: $6.00", "2026-03-02: $10.33"]


def test_currencies_are_reported_separately():
    day = {
        "2026-03-03": [
            Order("o-7", "NY", "USD", [Line("milk", 1, usd(149))]),
            Order("o-8", "TK", "JPY", [Line("onigiri", 2, Money(150, "JPY"))]),
        ]
    }
    assert report_lines(day) == ["2026-03-03: ¥300, $1.49"]
