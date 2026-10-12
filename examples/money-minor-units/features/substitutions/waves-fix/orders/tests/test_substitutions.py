from orders.model import Line
from orders.substitutions import substitution_difference
from shared.money import Money


def test_dearer_substitute_costs_the_difference():
    """A dearer substitute costs the difference between the two line totals."""
    original = Line("milk", 2, 1.49)
    substitute = Line("oat", 2, 1.99)
    assert substitution_difference(original, substitute, "USD") == Money(100, "USD")
