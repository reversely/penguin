from orders.model import Line, Order, order_total
from payouts.fees import payout, store_fee
from shared import money

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_fee_is_a_share_of_the_order_total():
    """A store fee is a share of the order total."""
    assert store_fee(ORDER) == 0.93


def test_payout_plus_fee_is_the_order_total():
    """A store's payout plus its fee equals the order total."""
    assert payout(ORDER) == 5.3
    assert money.total([payout(ORDER), store_fee(ORDER)]) == order_total(ORDER)
