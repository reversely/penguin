"""Ingestion and the identity map.

The web app identifies a person by ``user_id`` after login. The mobile app tracks a person by
``device_id`` until login and collects email. Each event belongs to one identity: ``user:<user_id>``
when the event has a ``user_id``, otherwise ``device:<device_id>``.

The identity map links identities that belong to one person and gives the person a ``person_id``.
Two merge rules link identities:

- A ``login`` event that carries both a ``user_id`` and a ``device_id`` links the two, while the
  device has linked fewer than ``MAX_IDENTITIES_PER_DEVICE`` user identities. Later users of a
  device at the limit stay separate people.
- Events that carry the same verified email link their identities.

A person's ``person_id`` is the key of the person's first-observed identity, so a person with one
identity keeps that identity's key. When two people merge, the merged profile keeps the latest
value of each attribute.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

LOGIN = "login"

# The number of user identities a login may link to one device.
MAX_IDENTITIES_PER_DEVICE = 5


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
    """Return the key of the identity an event belongs to."""
    if event.user_id:
        return f"user:{event.user_id}"
    if event.device_id:
        return f"device:{event.device_id}"
    raise ValueError(f"event at ts={event.ts} carries neither user_id nor device_id")


@dataclass
class Profile:
    """A person's profile and the attributes its events set.

    ``by_identity`` records each attribute per identity, keeping the value from that identity's
    event with the highest ``ts``. ``get`` returns the latest value across all the identities.
    """

    key: str
    identities: set[str] = field(default_factory=set)
    by_identity: dict[str, dict[str, tuple[int, object]]] = field(default_factory=dict)

    def set(self, identity: str, name: str, value: object, ts: int) -> None:
        values = self.by_identity.setdefault(identity, {})
        current = values.get(name)
        if current is None or ts >= current[0]:
            values[name] = (ts, value)

    def get(self, name: str, default: object = None) -> object:
        latest = max(
            (values[name] for values in self.by_identity.values() if name in values),
            key=lambda entry: entry[0],
            default=None,
        )
        return default if latest is None else latest[1]

    def absorb(self, other: "Profile") -> None:
        """Merge another person's identities and attributes into this profile."""
        self.identities |= other.identities
        for identity, values in other.by_identity.items():
            for name, (ts, value) in values.items():
                self.set(identity, name, value, ts)


class IdentityMap:
    """Links identities into people and holds each person's profile."""

    def __init__(self) -> None:
        # Union-find over identity keys: each identity points towards its person's root identity.
        self._parent: dict[str, str] = {}
        self._first_seen: dict[str, int] = {}
        self._profiles: dict[str, Profile] = {}
        self._verified_emails: dict[str, str] = {}
        self._device_users: dict[str, set[str]] = {}

    @classmethod
    def from_events(cls, events: Iterable[Event]) -> "IdentityMap":
        identity_map = cls()
        for event in sorted(events, key=lambda e: e.ts):
            identity_map.observe(event)
        return identity_map

    def observe(self, event: Event) -> Profile:
        identity = profile_key(event)
        person = self._add(identity)
        if event.type == LOGIN and event.user_id and event.device_id:
            device = f"device:{event.device_id}"
            if self._admit(device, identity):
                person = self._link(person, self._add(device))
        if event.email and event.email_verified:
            first = self._verified_emails.setdefault(event.email, identity)
            person = self._link(person, self.person_id(first))
        profile = self._profiles[person]
        if event.email:
            profile.set(identity, "email", event.email, event.ts)
        for name, value in event.traits.items():
            profile.set(identity, name, value, event.ts)
        return profile

    def person_id(self, identity: str) -> str:
        """Return the person_id of the person an identity belongs to."""
        while self._parent.get(identity, identity) != identity:
            identity = self._parent[identity]
        return identity

    def resolve(self, event: Event) -> str:
        """Return the person_id of the person an event belongs to."""
        return self.person_id(profile_key(event))

    def profile(self, key: str) -> Profile:
        """Return the profile of the person that owns the identity ``key``."""
        return self._profiles[self.person_id(key)]

    def profiles(self) -> list[Profile]:
        return [self._profiles[key] for key in sorted(self._profiles)]

    def _add(self, identity: str) -> str:
        if identity not in self._parent:
            self._parent[identity] = identity
            self._first_seen[identity] = len(self._first_seen)
            self._profiles[identity] = Profile(identity, {identity})
        return self.person_id(identity)

    def _admit(self, device: str, user: str) -> bool:
        """Return whether a login by ``user`` may link ``device``, recording the user if so."""
        users = self._device_users.setdefault(device, set())
        if user not in users and len(users) >= MAX_IDENTITIES_PER_DEVICE:
            return False
        users.add(user)
        return True

    def _link(self, first: str, second: str) -> str:
        """Merge two people; the person whose identity was observed first keeps its person_id."""
        if first == second:
            return first
        keep, merge = sorted((first, second), key=self._first_seen.__getitem__)
        self._parent[merge] = keep
        self._profiles[keep].absorb(self._profiles.pop(merge))
        return keep
