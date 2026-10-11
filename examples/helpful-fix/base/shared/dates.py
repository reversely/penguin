"""Day boundaries shared by every scope.

Every datetime in this repository carries a UTC offset. At this revision ``start_of_day`` keeps the
offset of the datetime it receives, so a caller picks the day by converting to an offset first.
"""

from datetime import date, datetime, timedelta


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
    return datetime.strptime(text, "%z").utcoffset()


def start_of_day(moment: datetime) -> datetime:
    """Return midnight at the start of the day of ``moment``, in the UTC offset of ``moment``."""
    require_offset(moment)
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)
