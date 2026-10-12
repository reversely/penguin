"""Days a store closes for a holiday."""

from datetime import datetime, timedelta, timezone

from shared.platform.dates import parse_utc_offset, start_of_day


def is_closed(moment: datetime, utc_offset: timedelta, closures: set[str]) -> bool:
    """Whether the store is closed at ``moment``: its local day, at ``utc_offset``, is a closure.

    ``closures`` holds ISO dates such as ``2026-12-25``.
    """
    local = moment.astimezone(timezone(utc_offset))
    return start_of_day(local).date().isoformat() in closures


def closed_at(
    moments: list[str], utc_offset: str, closures: list[str]
) -> dict[str, bool]:
    """Whether the store is closed at each ISO 8601 instant, for a store at ``utc_offset``."""
    offset = parse_utc_offset(utc_offset)
    return {
        text: is_closed(datetime.fromisoformat(text), offset, set(closures))
        for text in moments
    }
