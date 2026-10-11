"""Email audience for a re-engagement campaign."""

from collections.abc import Iterable

from ingestion.identity_map import Event, IdentityMap
from messaging.subscriptions import SUBSCRIBED, is_subscribed


def reengagement_audience(
    events: Iterable[Event], identity_map: IdentityMap, inactive_since: str
) -> list[str]:
    """Return the sorted email addresses of subscribed people last active before ``inactive_since``.

    An address that any profile has unsubscribed is suppressed, even when another profile with the
    same address is subscribed.
    """
    last_active: dict[str, str] = {}
    for event in events:
        key = identity_map.resolve(event)
        last_active[key] = max(event.day, last_active.get(key, event.day))

    profiles = identity_map.profiles()
    suppressed = {
        profile.get("email") for profile in profiles if profile.get(SUBSCRIBED) is False
    }
    return sorted(
        {
            profile.get("email")
            for profile in profiles
            if profile.get("email")
            and profile.get("email") not in suppressed
            and is_subscribed(profile)
            and last_active.get(profile.key, inactive_since) < inactive_since
        }
    )
