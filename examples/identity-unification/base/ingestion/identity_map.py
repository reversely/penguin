"""Ingestion and the identity map.

The web app identifies a person by ``user_id`` after login. The mobile app tracks a person by
``device_id`` until login and collects email. At this revision the identity map keys each profile
by the identity an event carries: ``user_id`` when the event has one, otherwise ``device_id``. It
does not link identities to each other.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Event:
    """One tracked event from the web or mobile app.

    ``ts`` orders events within the dataset. ``traits`` carries profile attributes the event sets,
    for example ``{"email_subscribed": False}`` on an unsubscribe.
    """

    source: str
    type: str
    day: str
    ts: int
    user_id: str | None = None
    device_id: str | None = None
    email: str | None = None
    email_verified: bool = False
    traits: Mapping[str, object] = field(default_factory=dict)


def profile_key(event: Event) -> str:
    """Return the key of the profile an event belongs to."""
    if event.user_id:
        return f"user:{event.user_id}"
    if event.device_id:
        return f"device:{event.device_id}"
    raise ValueError(f"event at ts={event.ts} carries neither user_id nor device_id")


@dataclass
class Profile:
    """A profile and the attributes its events set.

    Each attribute keeps the value from the event with the highest ``ts``.
    """

    key: str
    identities: set[str] = field(default_factory=set)
    attributes: dict[str, tuple[int, object]] = field(default_factory=dict)

    def set(self, name: str, value: object, ts: int) -> None:
        current = self.attributes.get(name)
        if current is None or ts >= current[0]:
            self.attributes[name] = (ts, value)

    def get(self, name: str, default: object = None) -> object:
        current = self.attributes.get(name)
        return default if current is None else current[1]


class IdentityMap:
    """Resolves events to profiles and holds each profile's attributes."""

    def __init__(self) -> None:
        self._profiles: dict[str, Profile] = {}

    @classmethod
    def from_events(cls, events: Iterable[Event]) -> "IdentityMap":
        identity_map = cls()
        for event in sorted(events, key=lambda e: e.ts):
            identity_map.observe(event)
        return identity_map

    def observe(self, event: Event) -> Profile:
        key = profile_key(event)
        profile = self._profiles.setdefault(key, Profile(key))
        if event.user_id:
            profile.identities.add(f"user:{event.user_id}")
        if event.device_id:
            profile.identities.add(f"device:{event.device_id}")
        if event.email:
            profile.set("email", event.email, event.ts)
        for name, value in event.traits.items():
            profile.set(name, value, event.ts)
        return profile

    def resolve(self, event: Event) -> str:
        """Return the key of the profile that counts as the event's person."""
        return profile_key(event)

    def profile(self, key: str) -> Profile:
        return self._profiles[key]

    def profiles(self) -> list[Profile]:
        return [self._profiles[key] for key in sorted(self._profiles)]
