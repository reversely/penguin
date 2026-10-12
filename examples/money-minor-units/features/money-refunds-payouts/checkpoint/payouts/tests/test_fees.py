from orders.model import Line, Order, order_total_minor
from payouts.fees import payout, store_fee
from shared.money import Money

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_fee_is_a_share_of_the_order_total():
    """A store fee is a share of the order total."""
    assert store_fee(ORDER) == Money(93, "USD")


def test_payout_plus_fee_is_the_order_total():
    """A store's payout plus its fee equals the order total."""
    assert payout(ORDER) == Money(530, "USD")
    assert payout(ORDER) + store_fee(ORDER) == order_total_minor(ORDER)


def test_fee_rounds_half_up_on_a_tie():
    order = Order("o-5", "NY", "USD", [Line("cheese", 1, 4.3)])
    assert store_fee(order) == Money(65, "USD")
