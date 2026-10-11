from messaging.receipts import receipt_text
from orders.model import Line, Order

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_receipt_lists_each_line_and_the_amount_paid():
    """A receipt shows the amount the customer paid."""
    assert (
        receipt_text(ORDER)
        == "Receipt for order o-1\nmilk $2.98\nbread $3.25\nPaid $6.23"
    )
