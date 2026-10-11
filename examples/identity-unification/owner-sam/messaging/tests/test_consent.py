from ingestion.identity_map import Event, IdentityMap
from messaging.audience import reengagement_audience


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
    identity_map = IdentityMap.from_events(events)
    assert reengagement_audience(events, identity_map, "2026-01-01") == []
