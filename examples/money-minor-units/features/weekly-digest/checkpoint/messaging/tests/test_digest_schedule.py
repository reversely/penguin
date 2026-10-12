from datetime import UTC, datetime, timedelta

from messaging.digest_schedule import Recipient, next_send, send_times

LONDON_WINTER = Recipient("s1", "s1@example.invalid", timedelta(0))
LOS_ANGELES_WINTER = Recipient("s2", "s2@example.invalid", timedelta(hours=-8))


def test_sends_later_today_before_the_hour():
    now = datetime(2026, 2, 9, 8, 0, tzinfo=UTC)
    assert next_send(LONDON_WINTER, now, 9) == datetime(2026, 2, 9, 9, 0, tzinfo=UTC)


def test_sends_tomorrow_once_the_hour_has_passed():
    now = datetime(2026, 2, 9, 10, 0, tzinfo=UTC)
    assert next_send(LONDON_WINTER, now, 9) == datetime(2026, 2, 10, 9, 0, tzinfo=UTC)


def test_goes_out_at_the_local_hour_west_of_utc():
    """The digest goes out at the shopper's local hour."""
    # 16:00 UTC is 08:00 for a shopper at UTC-08:00, so 09:00 local is 17:00 UTC the same day.
    now = datetime(2026, 2, 9, 16, 0, tzinfo=UTC)
    assert next_send(LOS_ANGELES_WINTER, now, 9) == datetime(
        2026, 2, 9, 17, 0, tzinfo=UTC
    )


def test_send_times_lists_each_shopper_in_order():
    now = datetime(2026, 2, 9, 8, 0, tzinfo=UTC)
    later = Recipient("s3", "s3@example.invalid", timedelta(0))
    assert send_times([later, LONDON_WINTER], now, 9) == {
        "s1": "2026-02-09T09:00:00+00:00",
        "s3": "2026-02-09T09:00:00+00:00",
    }
