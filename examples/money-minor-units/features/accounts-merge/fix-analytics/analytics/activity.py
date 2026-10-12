"""Analytics models built on the shopper map.

Daily active users count shoppers by ``shopper_id`` from a cutover day on. The cutover is the first day
on which the shopper map, built from the events through that day, attributes an event to a shopper
other than the event's own identity. Days before the cutover count identities, as they did before
the shopper map linked any, so a later login that links two identities never changes the count of a
day before the cutover.
"""

from collections import defaultdict
from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap, identity_key


def shopper_id_cutover(events: Iterable[Event]) -> str | None:
    """Return the first day on which the shopper map links an event to another identity.

    The map grows one day at a time, so an event on a later day cannot move the cutover earlier.
    """
    by_day: dict[str, list[Event]] = defaultdict(list)
    for event in sorted(events, key=lambda e: e.ts):
        by_day[event.day].append(event)

    shopper_map = ShopperMap()
    # One event per identity is enough: every event of an identity resolves to the same shopper.
    seen: dict[str, Event] = {}
    for day in sorted(by_day):
        for event in by_day[day]:
            shopper_map.observe(event)
            seen.setdefault(identity_key(event), event)
        if any(shopper_map.resolve(event) != key for key, event in seen.items()):
            return day
    return None


def daily_active_users(
    events: Iterable[Event], shopper_map: ShopperMap
) -> dict[str, int]:
    """Count the distinct shoppers active on each day, keyed by ISO date in ascending order."""
    events = list(events)
    cutover = shopper_id_cutover(events)
    active: dict[str, set[str]] = defaultdict(set)
    for event in events:
        if cutover is not None and event.day >= cutover:
            active[event.day].add(shopper_map.resolve(event))
        else:
            active[event.day].add(identity_key(event))
    return {day: len(active[day]) for day in sorted(active)}
