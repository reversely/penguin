"""Day boundaries shared by every scope.

Every datetime in this repository carries a UTC offset. ``start_of_day`` returns a UTC midnight, so
every datetime that names one instant falls on one day, whatever offset the datetime carries.
"""

from datetime import UTC, datetime


def require_offset(moment: datetime) -> None:
    """Raise ValueError when ``moment`` carries no UTC offset."""
    if moment.utcoffset() is None:
        raise ValueError(f"datetime without a UTC offset: {moment.isoformat()}")


def start_of_day(moment: datetime) -> datetime:
    """Return midnight UTC at the start of the UTC day that contains ``moment``."""
    require_offset(moment)
    return moment.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
