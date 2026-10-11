from datetime import UTC, datetime, timedelta

from messaging.contacts import Contact
from messaging.reminders import next_reminder

LONDON_WINTER = Contact("u1", "u1@example.invalid", timedelta(0))
LOS_ANGELES_WINTER = Contact("u2", "u2@example.invalid", timedelta(hours=-8))


def test_schedules_later_today_before_the_hour():
    now = datetime(2026, 2, 9, 8, 0, tzinfo=UTC)
    assert next_reminder(LONDON_WINTER, now, 9) == datetime(
        2026, 2, 9, 9, 0, tzinfo=UTC
    )


def test_schedules_tomorrow_once_the_hour_has_passed():
    now = datetime(2026, 2, 9, 10, 0, tzinfo=UTC)
    assert next_reminder(LONDON_WINTER, now, 9) == datetime(
        2026, 2, 10, 9, 0, tzinfo=UTC
    )


def test_fires_at_the_local_hour_west_of_utc():
    # 16:00 UTC is 08:00 for a contact at UTC-08:00, so 09:00 local is 17:00 UTC the same day.
    now = datetime(2026, 2, 9, 16, 0, tzinfo=UTC)
    assert next_reminder(LOS_ANGELES_WINTER, now, 9) == datetime(
        2026, 2, 9, 17, 0, tzinfo=UTC
    )
