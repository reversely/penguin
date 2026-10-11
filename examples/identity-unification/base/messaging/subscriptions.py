"""Email subscription store read from the identity map.

A ``subscribe`` or ``unsubscribe`` event sets the profile trait ``email_subscribed``. A profile
with no such event is not subscribed.
"""

from ingestion.identity_map import IdentityMap, Profile

SUBSCRIBED = "email_subscribed"


def is_subscribed(profile: Profile) -> bool:
    return profile.get(SUBSCRIBED) is True


def subscription_status(identity_map: IdentityMap) -> dict[str, bool]:
    """Map each profile key to whether that profile receives email."""
    return {profile.key: is_subscribed(profile) for profile in identity_map.profiles()}
