"""Days a store closes for a holiday."""


def is_closed(day: str, closures: set[str]) -> bool:
    """Whether the store is closed on ``day``, an ISO date such as ``2026-12-25``."""
    return day in closures
