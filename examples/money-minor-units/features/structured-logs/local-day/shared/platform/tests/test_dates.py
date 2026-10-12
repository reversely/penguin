from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from shared.platform.dates import (
    parse_day,
    parse_instant,
    parse_utc_offset,
    start_of_day,
    start_of_local_day,
)

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


def test_start_of_local_day_is_the_local_midnight_west_of_utc():
    # 04:30 UTC on 10 February is 20:30 on 9 February at UTC-08:00.
    moment = datetime(2026, 2, 10, 4, 30, tzinfo=UTC)
    assert start_of_local_day(moment, timedelta(hours=-8)).isoformat() == (
        "2026-02-09T00:00:00-08:00"
    )


def test_start_of_local_day_is_the_local_midnight_east_of_utc():
    # 20:00 UTC on 9 February is 05:00 on 10 February at UTC+09:00.
    moment = datetime(2026, 2, 9, 20, 0, tzinfo=UTC)
    assert start_of_local_day(moment, timedelta(hours=9)).isoformat() == (
        "2026-02-10T00:00:00+09:00"
    )


def test_start_of_local_day_refuses_a_datetime_without_an_offset():
    with pytest.raises(ValueError):
        start_of_local_day(datetime(2026, 2, 9, 15, 45), timedelta(0))


def test_parse_instant_keeps_the_offset():
    moment = parse_instant("2026-02-09T20:30:00-08:00")
    assert moment.utcoffset() == timedelta(hours=-8)
    assert moment.astimezone(UTC) == datetime(2026, 2, 10, 4, 30, tzinfo=UTC)


def test_parse_instant_refuses_a_datetime_without_an_offset():
    with pytest.raises(ValueError):
        parse_instant("2026-02-09T20:30:00")


def test_parse_day_and_parse_utc_offset_read_iso_text():
    assert parse_day("2026-02-09") == date(2026, 2, 9)
    assert parse_utc_offset("-08:00") == timedelta(hours=-8)
    assert parse_utc_offset("+05:30") == timedelta(hours=5, minutes=30)
