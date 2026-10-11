"""Reminder scheduling at each contact's local hour."""

from collections.abc import Iterable
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


def reminder_times(
    contacts: Iterable[Contact], now: datetime, local_hour: int
) -> dict[str, str]:
    """Return each contact's next reminder as an ISO 8601 UTC instant, keyed by ``user_id``.

    The send queue stores these strings, one per contact, in ``user_id`` order.
    """
    return {
        contact.user_id: next_reminder(contact, now, local_hour).isoformat()
        for contact in sorted(contacts, key=lambda contact: contact.user_id)
    }
