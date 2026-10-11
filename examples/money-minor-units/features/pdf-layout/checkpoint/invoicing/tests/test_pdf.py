from invoicing.pdf import amount_column
from orders.model import Line, Order

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_amounts_are_right_aligned():
    """An invoice's amounts are right-aligned in their column."""
    assert amount_column(ORDER, width=7) == ["  $2.98", "  $3.25"]
