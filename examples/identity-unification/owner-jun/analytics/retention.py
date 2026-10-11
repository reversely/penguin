"""Retention dashboard: daily active users and day-N retention by first-active-day cohort."""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from analytics.models import daily_active_users
from ingestion.identity_map import Event, IdentityMap


@dataclass(frozen=True)
class RetentionDashboard:
    """``dau`` maps each ISO date to its active people.

    ``cohorts`` maps each first-active ISO date to the number of that cohort's people active N days
    later, keyed by N; day 0 holds the cohort's size.
    """

    dau: dict[str, int]
    cohorts: dict[str, dict[int, int]]


def retention_dashboard(
    events: Iterable[Event], identity_map: IdentityMap
) -> RetentionDashboard:
    events = list(events)
    active_days: dict[str, set[str]] = defaultdict(set)
    for event in events:
        active_days[identity_map.resolve(event)].add(event.day)

    cohorts: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for days in active_days.values():
        first = min(days)
        for day in days:
            offset = (date.fromisoformat(day) - date.fromisoformat(first)).days
            cohorts[first][offset] += 1

    return RetentionDashboard(
        dau=daily_active_users(events, identity_map),
        cohorts={
            first: dict(sorted(counts.items()))
            for first, counts in sorted(cohorts.items())
        },
    )
