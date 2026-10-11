from orders.model import Line, Order
from refunds.credit import store_credit

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_credit_adds_the_bonus():
    """Store credit for returned lines is their refund plus the bonus for taking credit."""
    assert store_credit(ORDER, ["milk"]) == 3.28
