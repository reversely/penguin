import pytest

from accounts.shoppers import Event, ShopperMap, identity_key


def test_web_event_is_keyed_by_user_id():
    event = Event("web", "page_view", "2026-01-05", 1, user_id="u1")
    assert identity_key(event) == "user:u1"


def test_mobile_event_before_login_is_keyed_by_device_id():
    event = Event("mobile", "app_open", "2026-01-05", 1, device_id="d1")
    assert identity_key(event) == "device:d1"


def test_event_without_identity_is_rejected():
    with pytest.raises(ValueError):
        identity_key(Event("web", "page_view", "2026-01-05", 1))


def test_shoppers_are_listed_in_key_order():
    shopper_map = ShopperMap.from_events(
        [
            Event("web", "page_view", "2026-01-05", 2, user_id="u2"),
            Event("mobile", "app_open", "2026-01-05", 1, device_id="d1"),
            Event("web", "page_view", "2026-01-05", 3, user_id="u1"),
        ]
    )
    assert [p.key for p in shopper_map.shoppers()] == [
        "device:d1",
        "user:u1",
        "user:u2",
    ]


def test_latest_event_sets_an_attribute():
    shopper_map = ShopperMap.from_events(
        [
            Event(
                "web",
                "subscribe",
                "2026-01-05",
                1,
                user_id="u1",
                traits={"plan": "free"},
            ),
            Event(
                "web", "upgrade", "2026-01-06", 2, user_id="u1", traits={"plan": "pro"}
            ),
        ]
    )
    assert shopper_map.shopper("user:u1").get("plan") == "pro"


def test_events_are_applied_in_ts_order_whatever_the_input_order():
    shopper_map = ShopperMap.from_events(
        [
            Event(
                "web", "upgrade", "2026-01-06", 2, user_id="u1", traits={"plan": "pro"}
            ),
            Event(
                "web",
                "subscribe",
                "2026-01-05",
                1,
                user_id="u1",
                traits={"plan": "free"},
            ),
        ]
    )
    assert shopper_map.shopper("user:u1").get("plan") == "pro"


def test_email_is_recorded_on_the_shopper():
    shopper_map = ShopperMap.from_events(
        [
            Event(
                "mobile",
                "signup",
                "2026-01-05",
                1,
                device_id="d1",
                email="a@example.com",
            )
        ]
    )
    assert shopper_map.shopper("device:d1").get("email") == "a@example.com"
