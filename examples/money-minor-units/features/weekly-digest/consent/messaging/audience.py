"""Email audience for a weekly digest campaign."""

from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap, identity_key
from messaging.subscriptions import SUBSCRIBED, is_subscribed


def unsubscribed_shoppers(events: Iterable[Event], shopper_map: ShopperMap) -> set[str]:
    """Return the shopper keys of shoppers with an identity whose latest consent is an unsubscribe.

    Each identity's consent is the ``email_subscribed`` value of its latest event that sets one. A
    merged shopper keeps the latest value across all its identities, so an unsubscribe on one
    identity is checked here, per identity, before the merge can hide it.
    """
    latest: dict[str, Event] = {}
    for event in events:
        if SUBSCRIBED not in event.traits:
            continue
        identity = identity_key(event)
        if identity not in latest or event.ts >= latest[identity].ts:
            latest[identity] = event
    return {
        shopper_map.resolve(event)
        for event in latest.values()
        if event.traits[SUBSCRIBED] is False
    }


def digest_audience(
    events: Iterable[Event], shopper_map: ShopperMap, inactive_since: str
) -> list[str]:
    """Return the sorted email addresses of subscribed shoppers last active before ``inactive_since``.

    An address that any shopper has unsubscribed is suppressed, even when another shopper with the
    same address is subscribed. A shopper is left out when any identity linked to the shopper has
    unsubscribed.
    """
    events = list(events)
    last_active: dict[str, str] = {}
    for event in events:
        key = shopper_map.resolve(event)
        last_active[key] = max(event.day, last_active.get(key, event.day))

    shoppers = shopper_map.shoppers()
    unsubscribed = unsubscribed_shoppers(events, shopper_map)
    suppressed = {
        shopper.get("email") for shopper in shoppers if shopper.get(SUBSCRIBED) is False
    }
    return sorted(
        {
            str(shopper.get("email"))
            for shopper in shoppers
            if shopper.get("email")
            and shopper.get("email") not in suppressed
            and shopper.key not in unsubscribed
            and is_subscribed(shopper)
            and last_active.get(shopper.key, inactive_since) < inactive_since
        }
    )
