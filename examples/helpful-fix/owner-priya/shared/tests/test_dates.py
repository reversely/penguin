from datetime import UTC, datetime, timedelta, timezone

import pytest
from shared.dates import start_of_day

PACIFIC_STANDARD = timezone(timedelta(hours=-8))


def test_start_of_day_is_midnight_of_a_utc_moment():
    moment = datetime(2026, 2, 9, 15, 45, 12, tzinfo=UTC)
    assert start_of_day(moment) == datetime(2026, 2, 9, tzinfo=UTC)


def test_start_of_day_is_the_utc_midnight_of_a_moment_with_another_offset():
    # 23:30 at UTC-08:00 on 9 February is 07:30 UTC on 10 February.
    moment = datetime(2026, 2, 9, 23, 30, tzinfo=PACIFIC_STANDARD)
    assert start_of_day(moment).isoformat() == "2026-02-10T00:00:00+00:00"


def test_start_of_day_refuses_a_datetime_without_an_offset():
    with pytest.raises(ValueError):
        start_of_day(datetime(2026, 2, 9, 15, 45))
