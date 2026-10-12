"""Retention dashboard: daily active users and day-N retention by first-active-day cohort.

The dashboard counts shoppers by ``shopper_id`` from a cutover day on. The cutover is the first day on
which the shopper map, built from the events through that day, attributes an event to a shopper
other than the event's own identity. Days before the cutover count identities, as they did before
the shopper map linked any, so a later login that links two identities never changes the metrics
of a day before the cutover.
"""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from accounts.shoppers import Event, ShopperMap, identity_key


@dataclass(frozen=True)
class RetentionDashboard:
    """``dau`` maps each ISO date to its active shoppers.

    ``cohorts`` maps each first-active ISO date to the number of that cohort's shoppers active N days
    later, keyed by N; day 0 holds the cohort's size. ``cutover`` is the first ISO date counted by
    ``shopper_id``, or None when no day is.
    """

    dau: dict[str, int]
    cohorts: dict[str, dict[int, int]]
    cutover: str | None


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


def retention_dashboard(
    events: Iterable[Event], shopper_map: ShopperMap
) -> RetentionDashboard:
    events = list(events)
    cutover = shopper_id_cutover(events)

    def shopper(event: Event) -> str:
        if cutover is not None and event.day >= cutover:
            return shopper_map.resolve(event)
        return identity_key(event)

    active_shoppers: dict[str, set[str]] = defaultdict(set)
    active_days: dict[str, set[str]] = defaultdict(set)
    for event in events:
        key = shopper(event)
        active_shoppers[event.day].add(key)
        active_days[key].add(event.day)

    cohorts: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for days in active_days.values():
        first = min(days)
        for day in days:
            offset = (date.fromisoformat(day) - date.fromisoformat(first)).days
            cohorts[first][offset] += 1

    return RetentionDashboard(
        dau={day: len(active_shoppers[day]) for day in sorted(active_shoppers)},
        cohorts={
            first: dict(sorted(counts.items()))
            for first, counts in sorted(cohorts.items())
        },
        cutover=cutover,
    )
