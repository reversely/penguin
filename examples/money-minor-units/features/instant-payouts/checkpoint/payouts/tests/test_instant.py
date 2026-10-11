from orders.model import Line, Order
from payouts.instant import instant_payout

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_instant_payout_takes_the_flat_fee():
    assert instant_payout(ORDER) == 4.8
