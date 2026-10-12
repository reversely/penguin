"""Analytics models built on the identity map.

Daily active users count people by ``person_id`` from a cutover day on. The cutover is the first day
on which the identity map, built from the events through that day, attributes an event to a person
other than the event's own identity. Days before the cutover count identities, as they did before
the identity map linked any, so a later login that links two identities never changes the count of a
day before the cutover.
"""

from collections import defaultdict
from collections.abc import Iterable

from ingestion.identity_map import Event, IdentityMap, profile_key


def person_id_cutover(events: Iterable[Event]) -> str | None:
    """Return the first day on which the identity map links an event to another identity.

    The map grows one day at a time, so an event on a later day cannot move the cutover earlier.
    """
    by_day: dict[str, list[Event]] = defaultdict(list)
    for event in sorted(events, key=lambda e: e.ts):
        by_day[event.day].append(event)

    identity_map = IdentityMap()
    # One event per identity is enough: every event of an identity resolves to the same person.
    seen: dict[str, Event] = {}
    for day in sorted(by_day):
        for event in by_day[day]:
            identity_map.observe(event)
            seen.setdefault(profile_key(event), event)
        if any(identity_map.resolve(event) != key for key, event in seen.items()):
            return day
    return None


def daily_active_users(
    events: Iterable[Event], identity_map: IdentityMap
) -> dict[str, int]:
    """Count the distinct people active on each day, keyed by ISO date in ascending order."""
    events = list(events)
    cutover = person_id_cutover(events)
    active: dict[str, set[str]] = defaultdict(set)
    for event in events:
        if cutover is not None and event.day >= cutover:
            active[event.day].add(identity_map.resolve(event))
        else:
            active[event.day].add(profile_key(event))
    return {day: len(active[day]) for day in sorted(active)}
