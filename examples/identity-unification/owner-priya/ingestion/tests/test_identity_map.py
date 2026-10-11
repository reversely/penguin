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


def test_login_links_the_device_to_the_user():
    events = [
        Event("mobile", "app_open", "2026-01-05", 1, device_id="d1"),
        Event("web", "page_view", "2026-01-05", 2, user_id="u1"),
        Event("mobile", "login", "2026-01-05", 3, user_id="u1", device_id="d1"),
    ]
    identity_map = IdentityMap.from_events(events)
    assert {identity_map.resolve(event) for event in events} == {"device:d1"}
    assert identity_map.profile("user:u1").identities == {"device:d1", "user:u1"}


def test_an_event_without_login_does_not_link_its_device():
    identity_map = IdentityMap.from_events(
        [Event("web", "page_view", "2026-01-05", 1, user_id="u1", device_id="d1")]
    )
    assert identity_map.person_id("device:d1") == "device:d1"
    assert identity_map.person_id("user:u1") == "user:u1"


def test_verified_email_links_identities():
    identity_map = IdentityMap.from_events(
        [
            Event(
                "web",
                "signup",
                "2026-01-05",
                1,
                user_id="u1",
                email="a@example.com",
                email_verified=True,
            ),
            Event(
                "mobile",
                "signup",
                "2026-01-06",
                2,
                device_id="d1",
                email="a@example.com",
                email_verified=True,
            ),
        ]
    )
    assert identity_map.person_id("device:d1") == "user:u1"
    assert [p.key for p in identity_map.profiles()] == ["user:u1"]


def test_unverified_email_does_not_link_identities():
    identity_map = IdentityMap.from_events(
        [
            Event(
                "web", "signup", "2026-01-05", 1, user_id="u1", email="a@example.com"
            ),
            Event(
                "mobile",
                "signup",
                "2026-01-06",
                2,
                device_id="d1",
                email="a@example.com",
            ),
        ]
    )
    assert [p.key for p in identity_map.profiles()] == ["device:d1", "user:u1"]


def test_merged_profile_keeps_the_latest_value():
    identity_map = IdentityMap.from_events(
        [
            Event(
                "web", "upgrade", "2026-01-05", 1, user_id="u1", traits={"plan": "pro"}
            ),
            Event(
                "mobile",
                "downgrade",
                "2026-01-06",
                2,
                device_id="d1",
                traits={"plan": "free"},
            ),
            Event("mobile", "login", "2026-01-07", 3, user_id="u1", device_id="d1"),
        ]
    )
    assert identity_map.profile("device:d1").get("plan") == "free"
