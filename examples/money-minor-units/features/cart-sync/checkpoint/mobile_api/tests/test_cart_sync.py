from checkout.cart import CartLine
from mobile_api.cart_sync import cart_payload

LINES = [CartLine("milk", 2, 1.49), CartLine("bread", 1, 3.25)]


def test_payload_carries_items_and_total():
    """A cart payload carries its items and its total for display and in the minor unit."""
    assert cart_payload(LINES) == {
        "items": ["milk", "bread"],
        "total": "$6.23",
        "total_minor": 623,
    }
