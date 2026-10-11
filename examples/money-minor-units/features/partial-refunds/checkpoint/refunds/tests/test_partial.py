from orders.model import Line, Order
from refunds.partial import partial_refund

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_partial_refund_is_capped_at_the_quantity_bought():
    assert partial_refund(ORDER, "milk", 1) == 1.49
    assert partial_refund(ORDER, "milk", 5) == 2.98
