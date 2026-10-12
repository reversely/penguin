from orders.model import Line, Order
from refunds.partial import partial_refund
from shared.money import Money

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_partial_refund_is_capped_at_the_quantity_bought():
    """A partial refund never exceeds what was paid for the quantity bought."""
    assert partial_refund(ORDER, "milk", 1) == Money(149, "USD")
    assert partial_refund(ORDER, "milk", 5) == Money(298, "USD")
