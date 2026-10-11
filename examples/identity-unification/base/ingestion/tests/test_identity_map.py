import pytest

from ingestion.identity_map import Event, IdentityMap, profile_key


def test_web_event_is_keyed_by_user_id():
    event = Event("web", "page_view", "2026-01-05", 1, user_id="u1")
    assert profile_key(event) == "user:u1"


def test_mobile_event_before_login_is_keyed_by_device_id():
    event = Event("mobile", "app_open", "2026-01-05", 1, device_id="d1")
    assert profile_key(event) == "device:d1"


def test_event_without_identity_is_rejected():
    with pytest.raises(ValueError):
        profile_key(Event("web", "page_view", "2026-01-05", 1))


def test_profiles_are_listed_in_key_order():
    identity_map = IdentityMap.from_events(
        [
            Event("web", "page_view", "2026-01-05", 2, user_id="u2"),
            Event("mobile", "app_open", "2026-01-05", 1, device_id="d1"),
            Event("web", "page_view", "2026-01-05", 3, user_id="u1"),
        ]
    )
    assert [p.key for p in identity_map.profiles()] == [
        "device:d1",
        "user:u1",
        "user:u2",
    ]


def test_latest_event_sets_an_attribute():
    identity_map = IdentityMap.from_events(
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
    assert identity_map.profile("user:u1").get("plan") == "pro"


def test_events_are_applied_in_ts_order_whatever_the_input_order():
    identity_map = IdentityMap.from_events(
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
    assert identity_map.profile("user:u1").get("plan") == "pro"


def test_email_is_recorded_on_the_profile():
    identity_map = IdentityMap.from_events(
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
    assert identity_map.profile("device:d1").get("email") == "a@example.com"
