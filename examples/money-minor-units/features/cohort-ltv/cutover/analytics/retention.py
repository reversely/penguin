"""Retention dashboard: daily active users and day-N retention by first-active-day cohort.

Cohorts count identities before the shopper map's cutover day and shoppers from it on, with
``shopper_id_cutover()`` and ``counted_as()`` from ``accounts.shoppers``, as daily active users do.
A later login that links two identities never changes a cohort of a day before the cutover.
"""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from accounts.shoppers import Event, ShopperMap, counted_as, shopper_id_cutover
from analytics.activity import daily_active_users


@dataclass(frozen=True)
class RetentionDashboard:
    """``dau`` maps each ISO date to its active shoppers.

    ``cohorts`` maps each first-active ISO date to the number of that cohort's shoppers active N days
    later, keyed by N; day 0 holds the cohort's size.
    """

    dau: dict[str, int]
    cohorts: dict[str, dict[int, int]]


def retention_dashboard(
    events: Iterable[Event], shopper_map: ShopperMap
) -> RetentionDashboard:
    events = list(events)
    cutover = shopper_id_cutover(events)
    active_days: dict[str, set[str]] = defaultdict(set)
    for event in events:
        active_days[counted_as(event, shopper_map, cutover)].add(event.day)

    cohorts: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for days in active_days.values():
        first = min(days)
        for day in days:
            offset = (date.fromisoformat(day) - date.fromisoformat(first)).days
            cohorts[first][offset] += 1

    return RetentionDashboard(
        dau=daily_active_users(events, shopper_map),
        cohorts={
            first: dict(sorted(counts.items()))
            for first, counts in sorted(cohorts.items())
        },
    )
