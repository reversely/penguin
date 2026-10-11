from analytics.retention import retention_dashboard
from ingestion.identity_map import Event, IdentityMap


def _dashboard(events):
    return retention_dashboard(events, IdentityMap.from_events(events))


def test_cohorts_count_people_returning_on_later_days():
    events = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("web", "page_view", "2026-01-05", 2, user_id="u2"),
        Event("web", "page_view", "2026-01-06", 3, user_id="u1"),
        Event("web", "page_view", "2026-01-12", 4, user_id="u1"),
        Event("web", "page_view", "2026-01-06", 5, user_id="u3"),
    ]
    assert _dashboard(events).cohorts == {
        "2026-01-05": {0: 2, 1: 1, 7: 1},
        "2026-01-06": {0: 1},
    }


def test_dashboard_reports_daily_active_users():
    events = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("mobile", "app_open", "2026-01-05", 2, device_id="d1"),
        Event("web", "page_view", "2026-01-06", 3, user_id="u1"),
    ]
    assert _dashboard(events).dau == {"2026-01-05": 2, "2026-01-06": 1}


def test_dau_stable():
    """A published day's DAU stays the same when later days' events arrive."""
    published = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("mobile", "app_open", "2026-01-05", 2, device_id="d1"),
    ]
    later = [
        Event("mobile", "login", "2026-01-06", 3, user_id="u1", device_id="d1"),
    ]
    before = _dashboard(published)
    after = _dashboard(published + later)
    assert after.dau["2026-01-05"] == before.dau["2026-01-05"] == 2
    assert after.cohorts["2026-01-05"][0] == before.cohorts["2026-01-05"][0]
