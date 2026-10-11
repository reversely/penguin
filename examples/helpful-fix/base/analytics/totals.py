"""Activity totals built on ingested events."""

from collections import Counter
from collections.abc import Iterable

from ingestion.events import Event


def events_per_user(events: Iterable[Event]) -> dict[str, int]:
    """Count the events of each user, keyed by ``user_id`` in ascending order."""
    counts = Counter(event.user_id for event in events)
    return {user_id: counts[user_id] for user_id in sorted(counts)}
