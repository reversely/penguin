from orders.model import Line, Order, order_total
from payouts.fees import payout, store_fee
from shared import money
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_fee_is_a_share_of_the_order_total():
    assert store_fee(ORDER) == Money(93, "USD")


def test_payout_plus_fee_is_the_order_total():
    assert payout(ORDER) == Money(530, "USD")
    assert money.total([payout(ORDER), store_fee(ORDER)]) == order_total(ORDER)


def test_fee_rounds_half_up_on_a_tie():
    order = Order("o-5", "NY", "USD", [Line("cheese", 1, Money(430, "USD"))])
    assert store_fee(order) == Money(65, "USD")
