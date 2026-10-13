"""Email audience for a weekly digest campaign."""

from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap, withdrawn
from messaging.subscriptions import SUBSCRIBED, is_subscribed


def digest_audience(
    events: Iterable[Event], shopper_map: ShopperMap, inactive_since: str
) -> list[str]:
    """Return the sorted email addresses of subscribed shoppers last active before ``inactive_since``.

    An address that any shopper has unsubscribed is suppressed, even when another shopper with the
    same address is subscribed. ``withdrawn()`` from ``accounts.shoppers`` reads each identity linked
    to a shopper, so an unsubscribe on one identity suppresses the address after another subscribes.
    """
    last_active: dict[str, str] = {}
    for event in events:
        key = shopper_map.resolve(event)
        last_active[key] = max(event.day, last_active.get(key, event.day))

    shoppers = shopper_map.shoppers()
    suppressed = {
        shopper.get("email") for shopper in shoppers if withdrawn(shopper, SUBSCRIBED)
    }
    return sorted(
        {
            str(shopper.get("email"))
            for shopper in shoppers
            if shopper.get("email")
            and shopper.get("email") not in suppressed
            and is_subscribed(shopper)
            and last_active.get(shopper.key, inactive_since) < inactive_since
        }
    )
