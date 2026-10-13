"""Email subscription store read from the shopper map.

A ``subscribe`` or ``unsubscribe`` event sets the shopper trait ``email_subscribed``. A shopper
with no such event is not subscribed. ``consented()`` from ``accounts.shoppers`` reads each linked
identity's latest consent, so an unsubscribe on one identity holds after another identity of the
same shopper subscribes.
"""

from accounts.shoppers import Shopper, ShopperMap, consented

SUBSCRIBED = "email_subscribed"


def is_subscribed(shopper: Shopper) -> bool:
    return consented(shopper, SUBSCRIBED)


def subscription_status(shopper_map: ShopperMap) -> dict[str, bool]:
    """Map each shopper key to whether that shopper receives email."""
    return {shopper.key: is_subscribed(shopper) for shopper in shopper_map.shoppers()}
