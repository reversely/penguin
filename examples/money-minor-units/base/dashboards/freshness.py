"""Whether a dashboard's data is fresh enough to show."""

from datetime import datetime, timedelta


def is_stale(last_refresh: datetime, now: datetime, max_age_hours: int) -> bool:
    """Whether the dashboard's last refresh is older than its allowed age."""
    return now - last_refresh > timedelta(hours=max_age_hours)
