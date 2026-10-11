from analytics.retention import retention_dashboard
from ingestion.identity_map import Event, IdentityMap

LIBRARY_TABLET = "tablet-7"


def _login(ts, user_id, device_id):
    return Event(
        "mobile", "login", "2026-01-05", ts, user_id=user_id, device_id=device_id
    )


def _dau(events):
    return retention_dashboard(events, IdentityMap.from_events(events)).dau


def test_people_on_their_own_devices_count_separately():
    events = [_login(1, "u1", "d1"), _login(2, "u2", "d2")]
    assert _dau(events) == {"2026-01-05": 2}


def test_shared_device_split():
    """Patrons who log in on one library tablet stay separate people."""
    events = [
        _login(1, "u1", LIBRARY_TABLET),
        _login(2, "u2", LIBRARY_TABLET),
        _login(3, "u3", LIBRARY_TABLET),
    ]
    assert _dau(events) == {"2026-01-05": 3}
