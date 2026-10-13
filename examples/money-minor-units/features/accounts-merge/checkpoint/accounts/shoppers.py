"""Shopper accounts.

The web app identifies a shopper by ``user_id`` after login. The mobile app tracks a shopper by
``device_id`` until login and collects email. Each event belongs to one identity: ``user:<user_id>``
when the event has a ``user_id``, otherwise ``device:<device_id>``.

The shopper map links identities that belong to one shopper and gives the shopper a ``shopper_id``.
Two merge rules link identities:

- A ``login`` event that carries both a ``user_id`` and a ``device_id`` links the two.
- Events that carry the same verified email link their identities.

A shopper's ``shopper_id`` is the key of the shopper's first-observed identity, so a shopper with one
identity keeps that identity's key. When two shoppers merge, the merged shopper keeps the latest
value of each attribute.

Code that read shoppers before the merge rules calls two rules from this module:

- ``shopper_id_cutover()`` and ``counted_as()``: a metric counts identities before the first day the
  shopper map links any. It counts shoppers from that day on, so a published day keeps its count.
  ``ShopperMap.counted_as()`` gives the same key from the map alone, with the cutover of the events
  the map observed, for code that holds the map but not its events.
- ``consented()`` and ``withdrawn()``: a consent such as ``email_subscribed`` withdrawn on one
  identity stays withdrawn after another identity of the same shopper gives it.
"""

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

LOGIN = "login"


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
    """Return the key of the identity an event belongs to."""
    if event.user_id:
        return f"user:{event.user_id}"
    if event.device_id:
        return f"device:{event.device_id}"
    raise ValueError(f"event at ts={event.ts} carries neither user_id nor device_id")


@dataclass
class Shopper:
    """A shopper's shopper and the attributes its events set.

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

    def absorb(self, other: "Shopper") -> None:
        """Merge another shopper's identities and attributes into this shopper."""
        self.identities |= other.identities
        for identity, values in other.by_identity.items():
            for name, (ts, value) in values.items():
                self.set(identity, name, value, ts)


class ShopperMap:
    """Links identities into shoppers and holds each shopper's shopper."""

    def __init__(self) -> None:
        # Union-find over identity keys: each identity points towards its shopper's root identity.
        self._parent: dict[str, str] = {}
        self._observed: list[Event] = []
        # The cutover of the events observed so far, with how many there were when it was read.
        self._cutover: tuple[int, str | None] | None = None
        self._first_seen: dict[str, int] = {}
        self._shoppers: dict[str, Shopper] = {}
        self._verified_emails: dict[str, str] = {}

    @classmethod
    def from_events(cls, events: Iterable[Event]) -> "ShopperMap":
        shopper_map = cls()
        for event in sorted(events, key=lambda e: e.ts):
            shopper_map.observe(event)
        return shopper_map

    def observe(self, event: Event) -> Shopper:
        self._observed.append(event)
        identity = identity_key(event)
        shopper = self._add(identity)
        if event.type == LOGIN and event.user_id and event.device_id:
            shopper = self._link(shopper, self._add(f"device:{event.device_id}"))
        if event.email and event.email_verified:
            first = self._verified_emails.setdefault(event.email, identity)
            shopper = self._link(shopper, self.shopper_id(first))
        shopper = self._shoppers[shopper]
        if event.email:
            shopper.set(identity, "email", event.email, event.ts)
        for name, value in event.traits.items():
            shopper.set(identity, name, value, event.ts)
        return shopper

    def shopper_id(self, identity: str) -> str:
        """Return the shopper_id of the shopper an identity belongs to."""
        while self._parent.get(identity, identity) != identity:
            identity = self._parent[identity]
        return identity

    def resolve(self, event: Event) -> str:
        """Return the shopper_id of the shopper an event belongs to."""
        return self.shopper_id(identity_key(event))

    def counted_as(self, event: Event) -> str:
        """Return the key a metric counts ``event`` under, as ``counted_as()`` does, with the cutover
        of the events this map observed."""
        if self._cutover is None or self._cutover[0] != len(self._observed):
            self._cutover = (len(self._observed), shopper_id_cutover(self._observed))
        return counted_as(event, self, self._cutover[1])

    def shopper(self, key: str) -> Shopper:
        """Return the shopper of the shopper that owns the identity ``key``."""
        return self._shoppers[self.shopper_id(key)]

    def shoppers(self) -> list[Shopper]:
        return [self._shoppers[key] for key in sorted(self._shoppers)]

    def _add(self, identity: str) -> str:
        if identity not in self._parent:
            self._parent[identity] = identity
            self._first_seen[identity] = len(self._first_seen)
            self._shoppers[identity] = Shopper(identity, {identity})
        return self.shopper_id(identity)

    def _link(self, first: str, second: str) -> str:
        """Merge two shoppers; the shopper whose identity was observed first keeps its shopper_id."""
        if first == second:
            return first
        keep, merge = sorted((first, second), key=self._first_seen.__getitem__)
        self._parent[merge] = keep
        self._shoppers[keep].absorb(self._shoppers.pop(merge))
        return keep


def withdrawn(shopper: Shopper, name: str) -> bool:
    """Return whether any identity of the shopper last set the consent ``name`` to False.

    ``get`` returns the latest value across the identities, so a later consent on one identity
    hides a withdrawal on another. This reads each identity's own latest value.
    """
    return any(
        values[name][1] is False
        for values in shopper.by_identity.values()
        if name in values
    )


def consented(shopper: Shopper, name: str) -> bool:
    """Return whether the shopper's latest ``name`` is True and no identity withdrew it."""
    return shopper.get(name) is True and not withdrawn(shopper, name)


def shopper_id_cutover(events: Iterable[Event]) -> str | None:
    """Return the first day on which the shopper map links an event to another identity.

    The map grows one day at a time, so an event on a later day cannot move the cutover earlier.
    """
    by_day: dict[str, list[Event]] = defaultdict(list)
    for event in sorted(events, key=lambda e: e.ts):
        by_day[event.day].append(event)

    shopper_map = ShopperMap()
    # One event per identity is enough: every event of an identity resolves to the same shopper.
    seen: dict[str, Event] = {}
    for day in sorted(by_day):
        for event in by_day[day]:
            shopper_map.observe(event)
            seen.setdefault(identity_key(event), event)
        if any(shopper_map.resolve(event) != key for key, event in seen.items()):
            return day
    return None


def counted_as(event: Event, shopper_map: ShopperMap, cutover: str | None) -> str:
    """Return the key a metric counts ``event`` under.

    Before ``cutover`` it is the event's own identity, as before the shopper map linked any. From
    the cutover day on it is the event's ``shopper_id``.
    """
    if cutover is not None and event.day >= cutover:
        return shopper_map.resolve(event)
    return identity_key(event)
