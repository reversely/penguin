"""Analytics models built on the identity map."""

from collections import defaultdict
from collections.abc import Iterable

from ingestion.identity_map import Event, IdentityMap


def daily_active_users(
    events: Iterable[Event], identity_map: IdentityMap
) -> dict[str, int]:
    """Count the distinct people active on each day, keyed by ISO date in ascending order."""
    active: dict[str, set[str]] = defaultdict(set)
    for event in events:
        active[event.day].add(identity_map.resolve(event))
    return {day: len(active[day]) for day in sorted(active)}
