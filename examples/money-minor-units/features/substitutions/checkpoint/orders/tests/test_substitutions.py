from orders.model import Line
from orders.substitutions import substitution_difference


def test_dearer_substitute_costs_the_difference():
    """A dearer substitute costs the difference between the two line totals."""
    assert substitution_difference(Line("milk", 2, 1.49), Line("oat", 2, 1.99)) == 1.0
