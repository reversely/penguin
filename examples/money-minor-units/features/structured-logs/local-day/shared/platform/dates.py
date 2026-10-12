"""Day boundaries shared by every scope.

Every datetime in this repository carries a UTC offset. ``start_of_day`` returns a UTC midnight, so
every datetime that names one instant falls on one day, whatever offset the datetime carries.
``start_of_local_day`` returns the midnight of a store's or a shopper's local day, for code that
groups or schedules by that local calendar.
"""

from datetime import UTC, date, datetime, timedelta, timezone


def require_offset(moment: datetime) -> None:
    """Raise ValueError when ``moment`` carries no UTC offset."""
    if moment.utcoffset() is None:
        raise ValueError(f"datetime without a UTC offset: {moment.isoformat()}")


def parse_instant(text: str) -> datetime:
    """Parse an ISO 8601 instant that carries a UTC offset, such as ``2026-02-10T04:30:00+00:00``."""
    moment = datetime.fromisoformat(text)
    require_offset(moment)
    return moment


def parse_day(text: str) -> date:
    """Parse an ISO 8601 calendar day, such as ``2026-02-09``."""
    return date.fromisoformat(text)


def parse_utc_offset(text: str) -> timedelta:
    """Parse a UTC offset written ``+HH:MM`` or ``-HH:MM``, such as ``-08:00``."""
    offset = datetime.strptime(text, "%z").utcoffset()
    if offset is None:
        raise ValueError(f"not a UTC offset: {text}")
    return offset


def start_of_day(moment: datetime) -> datetime:
    """Return midnight UTC at the start of the UTC day that contains ``moment``."""
    require_offset(moment)
    return moment.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


def start_of_local_day(moment: datetime, utc_offset: timedelta) -> datetime:
    """Return local midnight at the start of the day that contains ``moment`` at ``utc_offset``.

    The result carries ``utc_offset``.
    """
    require_offset(moment)
    local = moment.astimezone(timezone(utc_offset))
    return local.replace(hour=0, minute=0, second=0, microsecond=0)
