"""Email subscription store read from the shopper map.

A ``subscribe`` or ``unsubscribe`` event sets the shopper trait ``email_subscribed``. A shopper
with no such event is not subscribed.
"""

from accounts.shoppers import Shopper, ShopperMap

SUBSCRIBED = "email_subscribed"


def is_subscribed(shopper: Shopper) -> bool:
    return shopper.get(SUBSCRIBED) is True


def subscription_status(shopper_map: ShopperMap) -> dict[str, bool]:
    """Map each shopper key to whether that shopper receives email."""
    return {shopper.key: is_subscribed(shopper) for shopper in shopper_map.shoppers()}
