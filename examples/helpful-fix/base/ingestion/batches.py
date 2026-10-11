"""Daily ingestion batches."""

from collections import defaultdict
from collections.abc import Iterable

from shared.dates import start_of_day

from ingestion.events import Event


def daily_batches(events: Iterable[Event]) -> dict[str, list[Event]]:
    """Group events into one batch per day, keyed by ISO date in ascending order.

    Each event goes into the batch of ``start_of_day(event.at)``.
    """
    batches: dict[str, list[Event]] = defaultdict(list)
    for event in events:
        batches[start_of_day(event.at).date().isoformat()].append(event)
    return {day: batches[day] for day in sorted(batches)}
