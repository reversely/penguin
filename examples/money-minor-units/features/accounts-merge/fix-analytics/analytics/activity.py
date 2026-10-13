"""Analytics models built on the shopper map.

Daily active users count identities before the shopper map's cutover day and shoppers from it on,
with ``shopper_id_cutover()`` and ``counted_as()`` from ``accounts.shoppers``. A later login that
links two identities never changes the count of a day before the cutover.
"""

from collections import defaultdict
from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap, counted_as, shopper_id_cutover


def daily_active_users(
    events: Iterable[Event], shopper_map: ShopperMap
) -> dict[str, int]:
    """Count the distinct shoppers active on each day, keyed by ISO date in ascending order."""
    events = list(events)
    cutover = shopper_id_cutover(events)
    active: dict[str, set[str]] = defaultdict(set)
    for event in events:
        active[event.day].add(counted_as(event, shopper_map, cutover))
    return {day: len(active[day]) for day in sorted(active)}
