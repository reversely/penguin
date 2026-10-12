"""Substitutes for items a store has run out of."""

from orders.model import Line, line_total_minor


def substitution_difference(original: Line, substitute: Line) -> float:
    """What the customer pays extra for a substitute; negative when it costs less."""
    difference = line_total_minor(substitute, "USD") - line_total_minor(original, "USD")
    return float(difference.major())
