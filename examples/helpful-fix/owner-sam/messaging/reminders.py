"""Reminder scheduling at each contact's local hour."""

from datetime import UTC, datetime, timedelta

from messaging.contacts import Contact, local_timezone
from shared.dates import start_of_day


def next_reminder(contact: Contact, now: datetime, local_hour: int) -> datetime:
    """Return the first instant after ``now`` at which the contact's local time is ``local_hour``:00.

    The result is in UTC.
    """
    local_now = now.astimezone(local_timezone(contact))
    reminder = start_of_day(local_now) + timedelta(hours=local_hour)
    if reminder <= now:
        reminder += timedelta(days=1)
    return reminder.astimezone(UTC)
