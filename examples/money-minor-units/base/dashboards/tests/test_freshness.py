from datetime import datetime

from dashboards.freshness import is_stale


def test_a_day_old_refresh_is_stale_for_an_hourly_board():
    assert is_stale(datetime(2026, 3, 1, 9), datetime(2026, 3, 2, 9), max_age_hours=1)
    assert not is_stale(
        datetime(2026, 3, 2, 8, 30), datetime(2026, 3, 2, 9), max_age_hours=1
    )
