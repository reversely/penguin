from datetime import date

from billing.cycle import billing_day


def test_billing_day_is_the_joining_day():
    assert billing_day(date(2026, 3, 9)) == 9


def test_late_joiners_bill_on_the_28th():
    assert billing_day(date(2026, 1, 31)) == 28
