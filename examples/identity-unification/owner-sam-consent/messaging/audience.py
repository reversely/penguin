"""Email audience for a re-engagement campaign."""

from collections.abc import Iterable

from ingestion.identity_map import Event, IdentityMap, profile_key
from messaging.subscriptions import SUBSCRIBED, is_subscribed


def unsubscribed_people(events: Iterable[Event], identity_map: IdentityMap) -> set[str]:
    """Return the profile keys of people with an identity whose latest consent is an unsubscribe.

    Each identity's consent is the ``email_subscribed`` value of its latest event that sets one. A
    merged profile keeps the latest value across all its identities, so an unsubscribe on one
    identity is checked here, per identity, before the merge can hide it.
    """
    latest: dict[str, Event] = {}
    for event in events:
        if SUBSCRIBED not in event.traits:
            continue
        identity = profile_key(event)
        if identity not in latest or event.ts >= latest[identity].ts:
            latest[identity] = event
    return {
        identity_map.resolve(event)
        for event in latest.values()
        if event.traits[SUBSCRIBED] is False
    }


def reengagement_audience(
    events: Iterable[Event], identity_map: IdentityMap, inactive_since: str
) -> list[str]:
    """Return the sorted email addresses of subscribed people last active before ``inactive_since``.

    An address that any profile has unsubscribed is suppressed, even when another profile with the
    same address is subscribed. A person is left out when any identity linked to the person has
    unsubscribed.
    """
    events = list(events)
    last_active: dict[str, str] = {}
    for event in events:
        key = identity_map.resolve(event)
        last_active[key] = max(event.day, last_active.get(key, event.day))

    profiles = identity_map.profiles()
    unsubscribed = unsubscribed_people(events, identity_map)
    suppressed = {
        profile.get("email") for profile in profiles if profile.get(SUBSCRIBED) is False
    }
    return sorted(
        {
            profile.get("email")
            for profile in profiles
            if profile.get("email")
            and profile.get("email") not in suppressed
            and profile.key not in unsubscribed
            and is_subscribed(profile)
            and last_active.get(profile.key, inactive_since) < inactive_since
        }
    )
