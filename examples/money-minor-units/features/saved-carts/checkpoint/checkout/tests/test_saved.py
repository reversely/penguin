from checkout.cart import CartLine
from checkout.saved import saved_cart_summary

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_summary_counts_items_and_shows_the_total():
    assert saved_cart_summary("Weekly shop", LINES) == "Weekly shop: 3 items, $6.23"
