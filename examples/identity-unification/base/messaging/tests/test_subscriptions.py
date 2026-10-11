from ingestion.identity_map import Event, IdentityMap
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


def test_profile_without_consent_event_is_not_subscribed():
    identity_map = IdentityMap.from_events(
        [Event("web", "page_view", "2026-01-05", 1, user_id="u1")]
    )
    assert subscription_status(identity_map) == {"user:u1": False}


def test_subscribe_then_unsubscribe_leaves_profile_unsubscribed():
    identity_map = IdentityMap.from_events(
        [_subscribe(1, user_id="u1"), _unsubscribe(2, user_id="u1")]
    )
    assert subscription_status(identity_map) == {"user:u1": False}


def test_unsubscribe_then_subscribe_again_leaves_profile_subscribed():
    identity_map = IdentityMap.from_events(
        [
            _subscribe(1, user_id="u1"),
            _unsubscribe(2, user_id="u1"),
            _subscribe(3, user_id="u1"),
        ]
    )
    assert subscription_status(identity_map) == {"user:u1": True}


def test_each_profile_keeps_its_own_status():
    identity_map = IdentityMap.from_events(
        [
            _subscribe(1, user_id="u1"),
            _subscribe(2, device_id="d2"),
            _unsubscribe(3, device_id="d2"),
        ]
    )
    assert subscription_status(identity_map) == {"device:d2": False, "user:u1": True}
