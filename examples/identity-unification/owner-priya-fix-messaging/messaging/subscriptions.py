"""Email subscription store read from the identity map.

A ``subscribe`` or ``unsubscribe`` event sets the profile trait ``email_subscribed``. A profile
with no such event is not subscribed. A person's profile keeps each linked identity's latest
consent, so an unsubscribe on one identity holds after another identity of the same person
subscribes.
"""

from ingestion.identity_map import IdentityMap, Profile

SUBSCRIBED = "email_subscribed"


def is_subscribed(profile: Profile) -> bool:
    """Return whether the person receives email.

    The latest consent across the person's identities must be a subscribe, and no identity's own
    latest consent may be an unsubscribe.
    """
    unsubscribed = any(
        values[SUBSCRIBED][1] is False
        for values in profile.by_identity.values()
        if SUBSCRIBED in values
    )
    return profile.get(SUBSCRIBED) is True and not unsubscribed


def subscription_status(identity_map: IdentityMap) -> dict[str, bool]:
    """Map each profile key to whether that profile receives email."""
    return {profile.key: is_subscribed(profile) for profile in identity_map.profiles()}
