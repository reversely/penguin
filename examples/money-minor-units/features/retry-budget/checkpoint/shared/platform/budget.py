"""A budget on retries, so a failing dependency is not flooded."""


def retries_left(budget: int, used: int) -> int:
    """The retries still allowed in this window, never below zero."""
    return max(budget - used, 0)
