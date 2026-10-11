from messaging.shipped import shipped_email
from orders.model import Line, Order
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_email_names_the_order_and_its_total():
    """A shipping email names the order and its total."""
    assert shipped_email(ORDER) == "Your order o-1 is on its way. Total $6.23."
