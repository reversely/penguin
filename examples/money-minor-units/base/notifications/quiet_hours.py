"""Shoppers' quiet hours, when no push notification is sent."""


def in_quiet_hours(hour: int, start: int, end: int) -> bool:
    """Whether an hour of the shopper's local day falls in quiet hours; a range past midnight wraps."""
    if start <= end:
        return start <= hour < end
    return hour >= start or hour < end
