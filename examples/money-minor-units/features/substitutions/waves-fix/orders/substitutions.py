"""Substitutes for items a store has run out of."""

from orders.model import Line, line_total_minor
from shared.money import Money


def substitution_difference(original: Line, substitute: Line, currency: str) -> Money:
    """What the customer pays extra for a substitute; negative when it costs less."""
    return line_total_minor(substitute, currency) - line_total_minor(original, currency)
