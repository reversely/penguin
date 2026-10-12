from accounts.shoppers import Event, ShopperMap
from messaging.audience import digest_audience


def test_unsubscribe_survives():
    """An unsubscribe on mobile holds after a later web signup subscribes the address by default."""
    events = [
        Event(
            "mobile",
            "unsubscribe",
            "2025-11-03",
            1,
            device_id="d1",
            email="a@example.com",
            email_verified=True,
            traits={"email_subscribed": False},
        ),
        Event(
            "web",
            "signup",
            "2025-11-10",
            2,
            user_id="u1",
            email="a@example.com",
            email_verified=True,
            traits={"email_subscribed": True},
        ),
    ]
    shopper_map = ShopperMap.from_events(events)
    assert digest_audience(events, shopper_map, "2026-01-01") == []


def test_a_later_subscribe_on_the_same_identity_replaces_its_unsubscribe():
    events = [
        Event(
            "web",
            "unsubscribe",
            "2025-11-03",
            1,
            user_id="u1",
            email="a@example.com",
            traits={"email_subscribed": False},
        ),
        Event(
            "web",
            "subscribe",
            "2025-11-10",
            2,
            user_id="u1",
            traits={"email_subscribed": True},
        ),
    ]
    shopper_map = ShopperMap.from_events(events)
    assert digest_audience(events, shopper_map, "2026-01-01") == ["a@example.com"]
