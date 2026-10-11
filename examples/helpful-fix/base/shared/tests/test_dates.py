from datetime import UTC, datetime

import pytest

from shared.dates import start_of_day


def test_start_of_day_is_midnight_of_a_utc_moment():
    moment = datetime(2026, 2, 9, 15, 45, 12, tzinfo=UTC)
    assert start_of_day(moment) == datetime(2026, 2, 9, tzinfo=UTC)


def test_start_of_day_refuses_a_datetime_without_an_offset():
    with pytest.raises(ValueError):
        start_of_day(datetime(2026, 2, 9, 15, 45))
