from invoicing.pdf import amount_column
from orders.model import Line, Order
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_amounts_are_right_aligned():
    assert amount_column(ORDER, width=7) == ["  $2.98", "  $3.25"]
