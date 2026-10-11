"""A store's opening hours."""


def is_open(hour: int, opens: int, closes: int) -> bool:
    """Whether the store is open at an hour of its local day; a close past midnight wraps."""
    if opens <= closes:
        return opens <= hour < closes
    return hour >= opens or hour < closes


def hours_label(opens: int, closes: int) -> str:
    """Opening hours as the dashboard shows them, such as ``08:00-22:00``."""
    return f"{opens:02d}:00-{closes:02d}:00"
