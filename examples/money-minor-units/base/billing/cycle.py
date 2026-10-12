"""The day of the month each store is billed for its Larder plan."""

from datetime import date


def billing_day(joined: date) -> int:
    """The store's billing day: the day it joined, moved to the 28th at most, so every month has it."""
    return min(joined.day, 28)
