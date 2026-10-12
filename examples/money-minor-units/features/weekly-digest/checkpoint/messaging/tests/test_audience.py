from accounts.shoppers import Event, ShopperMap
from messaging.audience import digest_audience

CAMPAIGN_CUTOFF = "2026-01-01"


def _subscribe(ts, day, email, **ids):
    return Event(
        "web",
        "subscribe",
        day,
        ts,
        email=email,
        traits={"email_subscribed": True},
        **ids,
    )


def _audience(events):
    return digest_audience(events, ShopperMap.from_events(events), CAMPAIGN_CUTOFF)


def test_inactive_subscribed_shoppers_are_in_the_audience():
    events = [
        _subscribe(1, "2025-11-03", "b@example.com", user_id="u2"),
        _subscribe(2, "2025-11-04", "a@example.com", user_id="u1"),
    ]
    assert _audience(events) == ["a@example.com", "b@example.com"]


def test_recently_active_shoppers_are_left_out():
    events = [
        _subscribe(1, "2025-11-03", "a@example.com", user_id="u1"),
        Event("web", "page_view", "2026-01-04", 2, user_id="u1"),
    ]
    assert _audience(events) == []


def test_shoppers_who_never_subscribed_are_left_out():
    events = [
        Event("web", "signup", "2025-11-03", 1, user_id="u1", email="a@example.com")
    ]
    assert _audience(events) == []


def test_an_address_unsubscribed_on_any_shopper_is_suppressed():
    events = [
        _subscribe(1, "2025-11-03", "a@example.com", user_id="u1"),
        Event(
            "mobile",
            "unsubscribe",
            "2025-11-04",
            2,
            device_id="d1",
            email="a@example.com",
            traits={"email_subscribed": False},
        ),
    ]
    assert _audience(events) == []
