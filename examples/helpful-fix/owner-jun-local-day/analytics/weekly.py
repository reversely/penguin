"""The weekly activity report."""

from collections.abc import Iterable, Mapping
from datetime import date, timedelta

from ingestion.events import Event
from shared.dates import start_of_local_day


def weekly_report(
    events: Iterable[Event], utc_offsets: Mapping[str, timedelta], week_start: date
) -> dict[str, int]:
    """Count the events on each of the seven days from ``week_start``, keyed by ISO date.

    Each event counts on its user's local day: the day of the event's instant at the UTC offset
    ``utc_offsets`` holds for the event's user. Events outside the week do not count.
    """
    counts = {(week_start + timedelta(days=n)).isoformat(): 0 for n in range(7)}
    for event in events:
        local_day = start_of_local_day(event.at, utc_offsets[event.user_id])
        day = local_day.date().isoformat()
        if day in counts:
            counts[day] += 1
    return counts
