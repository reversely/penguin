from orders.model import Line, Order
from refunds.refund import refund_amount, refund_cents

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_refund_covers_only_the_returned_lines():
    """A refund never exceeds what was paid for the returned lines."""
    assert refund_amount(ORDER, ["milk"]) == 2.98


def test_refund_is_sent_in_cents():
    """A refund is sent to the card processor in cents."""
    assert refund_cents(ORDER, ["milk", "bread"]) == 623
