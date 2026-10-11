"""Retention dashboard: daily active users and day-N retention by first-active-day cohort.

The dashboard counts people by ``person_id`` from a cutover day on. The cutover is the first day on
which the identity map, built from the events through that day, attributes an event to a person
other than the event's own identity. Days before the cutover count identities, as they did before
the identity map linked any, so a later login that links two identities never changes the metrics
of a day before the cutover.
"""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from ingestion.identity_map import Event, IdentityMap, profile_key


@dataclass(frozen=True)
class RetentionDashboard:
    """``dau`` maps each ISO date to its active people.

    ``cohorts`` maps each first-active ISO date to the number of that cohort's people active N days
    later, keyed by N; day 0 holds the cohort's size. ``cutover`` is the first ISO date counted by
    ``person_id``, or None when no day is.
    """

    dau: dict[str, int]
    cohorts: dict[str, dict[int, int]]
    cutover: str | None


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


def retention_dashboard(
    events: Iterable[Event], identity_map: IdentityMap
) -> RetentionDashboard:
    events = list(events)
    cutover = person_id_cutover(events)

    def person(event: Event) -> str:
        if cutover is not None and event.day >= cutover:
            return identity_map.resolve(event)
        return profile_key(event)

    active_people: dict[str, set[str]] = defaultdict(set)
    active_days: dict[str, set[str]] = defaultdict(set)
    for event in events:
        key = person(event)
        active_people[event.day].add(key)
        active_days[key].add(event.day)

    cohorts: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for days in active_days.values():
        first = min(days)
        for day in days:
            offset = (date.fromisoformat(day) - date.fromisoformat(first)).days
            cohorts[first][offset] += 1

    return RetentionDashboard(
        dau={day: len(active_people[day]) for day in sorted(active_people)},
        cohorts={
            first: dict(sorted(counts.items()))
            for first, counts in sorted(cohorts.items())
        },
        cutover=cutover,
    )
