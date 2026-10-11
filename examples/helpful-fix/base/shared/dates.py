"""Day boundaries shared by every scope.

Every datetime in this repository carries a UTC offset. At this revision ``start_of_day`` keeps the
offset of the datetime it receives, so a caller picks the day by converting to an offset first.
"""

from datetime import datetime


def require_offset(moment: datetime) -> None:
    """Raise ValueError when ``moment`` carries no UTC offset."""
    if moment.utcoffset() is None:
        raise ValueError(f"datetime without a UTC offset: {moment.isoformat()}")


def start_of_day(moment: datetime) -> datetime:
    """Return midnight at the start of the day of ``moment``, in the UTC offset of ``moment``."""
    require_offset(moment)
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)
