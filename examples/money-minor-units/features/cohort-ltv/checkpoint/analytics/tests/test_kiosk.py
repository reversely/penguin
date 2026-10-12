from accounts.shoppers import Event, ShopperMap
from analytics.retention import retention_dashboard

PICKUP_KIOSK = "kiosk-7"


def _login(ts, user_id, device_id):
    return Event(
        "mobile", "login", "2026-01-05", ts, user_id=user_id, device_id=device_id
    )


def _dau(events):
    return retention_dashboard(events, ShopperMap.from_events(events)).dau


def test_shoppers_on_their_own_devices_count_separately():
    events = [_login(1, "u1", "d1"), _login(2, "u2", "d2")]
    assert _dau(events) == {"2026-01-05": 2}


def test_shared_device_split():
    """Shoppers who log in on one pickup kiosk stay separate shoppers."""
    events = [
        _login(1, "u1", PICKUP_KIOSK),
        _login(2, "u2", PICKUP_KIOSK),
        _login(3, "u3", PICKUP_KIOSK),
    ]
    assert _dau(events) == {"2026-01-05": 3}
