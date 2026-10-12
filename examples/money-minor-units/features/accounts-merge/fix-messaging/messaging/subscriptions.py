"""Email subscription store read from the shopper map.

A ``subscribe`` or ``unsubscribe`` event sets the shopper trait ``email_subscribed``. A shopper
with no such event is not subscribed. A shopper's shopper keeps each linked identity's latest
consent, so an unsubscribe on one identity holds after another identity of the same shopper
subscribes.
"""

from accounts.shoppers import Shopper, ShopperMap

SUBSCRIBED = "email_subscribed"


def is_subscribed(shopper: Shopper) -> bool:
    """Return whether the shopper receives email.

    The latest consent across the shopper's identities must be a subscribe, and no identity's own
    latest consent may be an unsubscribe.
    """
    unsubscribed = any(
        values[SUBSCRIBED][1] is False
        for values in shopper.by_identity.values()
        if SUBSCRIBED in values
    )
    return shopper.get(SUBSCRIBED) is True and not unsubscribed


def subscription_status(shopper_map: ShopperMap) -> dict[str, bool]:
    """Map each shopper key to whether that shopper receives email."""
    return {shopper.key: is_subscribed(shopper) for shopper in shopper_map.shoppers()}
