"""Tracked events as ingestion receives them."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Event:
    """One tracked event.

    ``at`` is the instant the event happened, with the UTC offset of the device that recorded it.
    """

    user_id: str
    at: datetime
