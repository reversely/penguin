"""Day boundaries shared by every scope.

Every datetime in this repository carries a UTC offset. ``start_of_day`` returns a UTC midnight, so
every datetime that names one instant falls on one day, whatever offset the datetime carries.
``start_of_local_day`` returns the midnight of a user's local day, for code that groups or schedules
by the user's own calendar.
"""

from datetime import UTC, datetime, timedelta, timezone


def require_offset(moment: datetime) -> None:
    """Raise ValueError when ``moment`` carries no UTC offset."""
    if moment.utcoffset() is None:
        raise ValueError(f"datetime without a UTC offset: {moment.isoformat()}")


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
