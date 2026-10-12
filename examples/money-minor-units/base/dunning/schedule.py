"""When an overdue business invoice gets a reminder."""

from datetime import date, timedelta

# Days after the due date on which a reminder goes out.
REMINDER_DAYS = (3, 10, 30)


def reminder_dates(due: date) -> list[date]:
    """The days an unpaid invoice due on ``due`` gets a reminder."""
    return [due + timedelta(days=days) for days in REMINDER_DAYS]
