from accounts.shoppers import Event, ShopperMap
from messaging.crm_sync import crm_rows


def test_only_shoppers_with_email_are_synced():
    shopper_map = ShopperMap.from_events(
        [
            Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
            Event(
                "web", "signup", "2026-01-05", 2, user_id="u2", email="b@example.com"
            ),
        ]
    )
    assert crm_rows(shopper_map) == [
        {"shopper": "user:u2", "email": "b@example.com", "subscribed": False}
    ]


def test_rows_carry_subscription_status_in_shopper_order():
    shopper_map = ShopperMap.from_events(
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
    assert crm_rows(shopper_map) == [
        {"shopper": "device:d1", "email": "a@example.com", "subscribed": False},
        {"shopper": "user:u2", "email": "b@example.com", "subscribed": True},
    ]
