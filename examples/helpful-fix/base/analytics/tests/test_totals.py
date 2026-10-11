from datetime import UTC, datetime

from ingestion.events import Event

from analytics.totals import events_per_user


def test_counts_the_events_of_each_user():
    events = [
        Event("u2", datetime(2026, 2, 9, 8, 0, tzinfo=UTC)),
        Event("u1", datetime(2026, 2, 9, 9, 0, tzinfo=UTC)),
        Event("u2", datetime(2026, 2, 10, 8, 0, tzinfo=UTC)),
    ]
    assert list(events_per_user(events).items()) == [("u1", 1), ("u2", 2)]
