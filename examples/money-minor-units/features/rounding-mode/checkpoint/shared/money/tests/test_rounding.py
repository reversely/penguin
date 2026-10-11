from decimal import Decimal

from shared.money.rounding import ROUNDING

CENT = Decimal("0.01")


def test_ties_round_to_the_even_cent():
    assert Decimal("0.125").quantize(CENT, rounding=ROUNDING) == Decimal("0.12")
    assert Decimal("0.135").quantize(CENT, rounding=ROUNDING) == Decimal("0.14")
