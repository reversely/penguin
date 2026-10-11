from orders.model import Line, Order
from refunds.refund import refund_amount, refund_cents
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_refund_covers_only_the_returned_lines():
    """A refund never exceeds what was paid for the returned lines."""
    assert refund_amount(ORDER, ["milk"]) == Money(298, "USD")


def test_refund_is_sent_in_cents():
    """A refund is sent to the card processor in cents."""
    assert refund_cents(ORDER, ["milk", "bread"]) == 623
