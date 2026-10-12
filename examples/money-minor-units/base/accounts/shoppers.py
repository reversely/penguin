"""Shopper accounts.

The web app identifies a shopper by ``user_id`` after login. The mobile app tracks a shopper by
``device_id`` until login and collects email. At this revision the shopper map keys each shopper
by the identity an event carries: ``user_id`` when the event has one, otherwise ``device_id``. It
does not link identities to each other.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Event:
    """One tracked event from the web or mobile app.

    ``ts`` orders events within the dataset. ``traits`` carries shopper attributes the event sets,
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


def identity_key(event: Event) -> str:
    """Return the key of the shopper an event belongs to."""
    if event.user_id:
        return f"user:{event.user_id}"
    if event.device_id:
        return f"device:{event.device_id}"
    raise ValueError(f"event at ts={event.ts} carries neither user_id nor device_id")


@dataclass
class Shopper:
    """A shopper and the attributes its events set.

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


class ShopperMap:
    """Resolves events to shoppers and holds each shopper's attributes."""

    def __init__(self) -> None:
        self._shoppers: dict[str, Shopper] = {}

    @classmethod
    def from_events(cls, events: Iterable[Event]) -> "ShopperMap":
        shopper_map = cls()
        for event in sorted(events, key=lambda e: e.ts):
            shopper_map.observe(event)
        return shopper_map

    def observe(self, event: Event) -> Shopper:
        key = identity_key(event)
        shopper = self._shoppers.setdefault(key, Shopper(key))
        if event.user_id:
            shopper.identities.add(f"user:{event.user_id}")
        if event.device_id:
            shopper.identities.add(f"device:{event.device_id}")
        if event.email:
            shopper.set("email", event.email, event.ts)
        for name, value in event.traits.items():
            shopper.set(name, value, event.ts)
        return shopper

    def resolve(self, event: Event) -> str:
        """Return the key of the shopper that counts as the event's shopper."""
        return identity_key(event)

    def shopper(self, key: str) -> Shopper:
        return self._shoppers[key]

    def shoppers(self) -> list[Shopper]:
        return [self._shoppers[key] for key in sorted(self._shoppers)]
