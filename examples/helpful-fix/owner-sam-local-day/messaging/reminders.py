"""Reminder scheduling at each contact's local hour."""

from datetime import UTC, datetime, timedelta

from messaging.contacts import Contact
from shared.dates import start_of_local_day


def next_reminder(contact: Contact, now: datetime, local_hour: int) -> datetime:
    """Return the first instant after ``now`` at which the contact's local time is ``local_hour``:00.

    The result is in UTC.
    """
    reminder = start_of_local_day(now, contact.utc_offset) + timedelta(hours=local_hour)
    if reminder <= now:
        reminder += timedelta(days=1)
    return reminder.astimezone(UTC)
