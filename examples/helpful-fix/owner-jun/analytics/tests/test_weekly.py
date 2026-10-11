from datetime import UTC, date, datetime, timedelta

from analytics.weekly import weekly_report
from ingestion.events import Event

# The week of Monday 9 February 2026.
WEEK_START = date(2026, 2, 9)
NO_ACTIVITY = {(WEEK_START + timedelta(days=n)).isoformat(): 0 for n in range(7)}


def test_counts_each_day_of_the_week():
    events = [
        Event("u1", datetime(2026, 2, 9, 10, 0, tzinfo=UTC)),
        Event("u1", datetime(2026, 2, 11, 10, 0, tzinfo=UTC)),
        Event("u2", datetime(2026, 2, 11, 15, 0, tzinfo=UTC)),
    ]
    offsets = {"u1": timedelta(0), "u2": timedelta(0)}
    assert weekly_report(events, offsets, WEEK_START) == {
        **NO_ACTIVITY,
        "2026-02-09": 1,
        "2026-02-11": 2,
    }


def test_leaves_out_activity_outside_the_week():
    events = [
        Event("u1", datetime(2026, 2, 8, 23, 0, tzinfo=UTC)),
        Event("u1", datetime(2026, 2, 16, 1, 0, tzinfo=UTC)),
    ]
    assert weekly_report(events, {"u1": timedelta(0)}, WEEK_START) == NO_ACTIVITY


def test_evening_activity_west_of_utc_stays_on_its_local_day():
    """Evening activity west of UTC stays on its local day."""
    # The user lives at UTC-08:00. 04:30 UTC on Tuesday is 20:30 on Monday for that user.
    events = [Event("u1", datetime(2026, 2, 10, 4, 30, tzinfo=UTC))]
    offsets = {"u1": timedelta(hours=-8)}
    assert weekly_report(events, offsets, WEEK_START) == {
        **NO_ACTIVITY,
        "2026-02-09": 1,
    }
