from ingestion.identity_map import Event, IdentityMap

from messaging.crm_sync import crm_rows


def test_only_profiles_with_email_are_synced():
    identity_map = IdentityMap.from_events(
        [
            Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
            Event(
                "web", "signup", "2026-01-05", 2, user_id="u2", email="b@example.com"
            ),
        ]
    )
    assert crm_rows(identity_map) == [
        {"profile": "user:u2", "email": "b@example.com", "subscribed": False}
    ]


def test_rows_carry_subscription_status_in_profile_order():
    identity_map = IdentityMap.from_events(
        [
            Event(
                "web",
                "subscribe",
                "2026-01-05",
                1,
                user_id="u2",
                email="b@example.com",
                traits={"email_subscribed": True},
            ),
            Event(
                "mobile",
                "signup",
                "2026-01-05",
                2,
                device_id="d1",
                email="a@example.com",
            ),
        ]
    )
    assert crm_rows(identity_map) == [
        {"profile": "device:d1", "email": "a@example.com", "subscribed": False},
        {"profile": "user:u2", "email": "b@example.com", "subscribed": True},
    ]
