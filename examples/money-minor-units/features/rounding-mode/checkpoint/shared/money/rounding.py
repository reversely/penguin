"""The rounding mode of every money calculation."""

from decimal import ROUND_HALF_EVEN

# Banker's rounding: a tie rounds to the even digit, so ties do not all drift one way.
ROUNDING = ROUND_HALF_EVEN
