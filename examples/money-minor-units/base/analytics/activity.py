"""Analytics models built on the shopper map."""

from collections import defaultdict
from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap


def daily_active_users(
    events: Iterable[Event], shopper_map: ShopperMap
) -> dict[str, int]:
    """Count the distinct shoppers active on each day, keyed by ISO date in ascending order."""
    active: dict[str, set[str]] = defaultdict(set)
    for event in events:
        active[event.day].add(shopper_map.resolve(event))
    return {day: len(active[day]) for day in sorted(active)}
