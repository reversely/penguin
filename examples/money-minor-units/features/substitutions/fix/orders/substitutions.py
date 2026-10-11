"""Substitutes for items a store has run out of."""

from orders.model import Line, line_total
from shared import money


def substitution_difference(original: Line, substitute: Line) -> money.Money:
    """What the customer pays extra for a substitute; negative when it costs less."""
    return line_total(substitute) - line_total(original)
