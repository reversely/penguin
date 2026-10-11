from messaging.shipped import shipped_email
from orders.model import Line, Order

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_email_names_the_order_and_its_total():
    assert shipped_email(ORDER) == "Your order o-1 is on its way. Total $6.23."
