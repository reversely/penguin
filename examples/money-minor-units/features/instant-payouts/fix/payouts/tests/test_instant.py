from orders.model import Line, Order
from payouts.instant import instant_payout
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_instant_payout_takes_the_flat_fee():
    """An instant payout is the usual payout less the flat instant fee."""
    assert instant_payout(ORDER) == Money(480, "USD")
