from datetime import UTC, datetime, timedelta, timezone

from shared.platform.logs import log_day, log_line


def test_log_keys_are_sorted():
    assert log_line("order.placed", store="s-1", items=3) == (
        '{"event": "order.placed", "items": 3, "store": "s-1"}'
    )


def test_lines_written_at_one_instant_share_a_partition():
    """Log lines written at one instant go into one day's partition, whatever offset they carry."""
    # A store's tablet at UTC-08:00 and a server in UTC write at the same instant.
    tablet = datetime(2026, 2, 9, 23, 30, tzinfo=timezone(timedelta(hours=-8)))
    server = datetime(2026, 2, 10, 7, 30, tzinfo=UTC)
    assert log_day(tablet) == log_day(server) == "2026-02-10"
