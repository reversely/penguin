from accounts.shoppers import Event, ShopperMap
from messaging.subscriptions import subscription_status


def _subscribe(ts, **ids):
    return Event(
        "web", "subscribe", "2026-01-05", ts, traits={"email_subscribed": True}, **ids
    )


def _unsubscribe(ts, **ids):
    return Event(
        "web",
        "unsubscribe",
        "2026-01-06",
        ts,
        traits={"email_subscribed": False},
        **ids,
    )


def test_shopper_without_consent_event_is_not_subscribed():
    shopper_map = ShopperMap.from_events(
        [Event("web", "page_view", "2026-01-05", 1, user_id="u1")]
    )
    assert subscription_status(shopper_map) == {"user:u1": False}


def test_subscribe_then_unsubscribe_leaves_shopper_unsubscribed():
    shopper_map = ShopperMap.from_events(
        [_subscribe(1, user_id="u1"), _unsubscribe(2, user_id="u1")]
    )
    assert subscription_status(shopper_map) == {"user:u1": False}


def test_unsubscribe_then_subscribe_again_leaves_shopper_subscribed():
    shopper_map = ShopperMap.from_events(
        [
            _subscribe(1, user_id="u1"),
            _unsubscribe(2, user_id="u1"),
            _subscribe(3, user_id="u1"),
        ]
    )
    assert subscription_status(shopper_map) == {"user:u1": True}


def test_each_shopper_keeps_its_own_status():
    shopper_map = ShopperMap.from_events(
        [
            _subscribe(1, user_id="u1"),
            _subscribe(2, device_id="d2"),
            _unsubscribe(3, device_id="d2"),
        ]
    )
    assert subscription_status(shopper_map) == {"device:d2": False, "user:u1": True}


def test_unsubscribe_on_a_linked_identity_holds_after_a_signup():
    """An unsubscribe on any linked identity holds after a later signup subscribes the address by default."""
    shopper_map = ShopperMap.from_events(
        [
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
    )
    assert subscription_status(shopper_map) == {"device:d1": False}
