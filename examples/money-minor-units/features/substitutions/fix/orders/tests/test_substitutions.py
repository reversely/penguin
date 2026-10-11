from orders.model import Line
from orders.substitutions import substitution_difference
from shared.money import Money


def test_dearer_substitute_costs_the_difference():
    original = Line("milk", 2, Money(149, "USD"))
    substitute = Line("oat", 2, Money(199, "USD"))
    assert substitution_difference(original, substitute) == Money(100, "USD")
