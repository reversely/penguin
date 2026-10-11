from datetime import UTC, datetime, timedelta, timezone

from ingestion.batches import daily_batches
from ingestion.events import Event


def test_events_on_two_days_form_two_batches_in_date_order():
    tuesday = Event("u1", datetime(2026, 2, 10, 8, 0, tzinfo=UTC))
    monday = Event("u2", datetime(2026, 2, 9, 8, 0, tzinfo=UTC))
    later_monday = Event("u1", datetime(2026, 2, 9, 18, 0, tzinfo=UTC))
    assert daily_batches([tuesday, monday, later_monday]) == {
        "2026-02-09": [monday, later_monday],
        "2026-02-10": [tuesday],
    }


def test_events_at_one_instant_share_a_batch():
    # A phone at UTC-08:00 and a server in UTC record the same instant.
    phone = Event(
        "u1", datetime(2026, 2, 9, 23, 30, tzinfo=timezone(timedelta(hours=-8)))
    )
    server = Event("u2", datetime(2026, 2, 10, 7, 30, tzinfo=UTC))
    assert daily_batches([phone, server]) == {"2026-02-10": [phone, server]}
