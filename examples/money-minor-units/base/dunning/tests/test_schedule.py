from datetime import date

from dunning.schedule import reminder_dates


def test_three_reminders_after_the_due_date():
    assert reminder_dates(date(2026, 3, 1)) == [
        date(2026, 3, 4),
        date(2026, 3, 11),
        date(2026, 3, 31),
    ]
