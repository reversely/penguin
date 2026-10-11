from checkout.cart import CartLine
from checkout.saved import saved_cart_summary
from shared.money import Money

LINES = [
    CartLine("milk", 2, Money(149, "USD")),
    CartLine("bread", 1, Money(325, "USD")),
]


def test_summary_counts_items_and_shows_the_total():
    """A saved cart's summary counts its items and shows the cart total."""
    assert saved_cart_summary("Weekly shop", LINES) == "Weekly shop: 3 items, $6.23"
