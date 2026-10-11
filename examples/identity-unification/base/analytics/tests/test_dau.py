from ingestion.identity_map import Event, IdentityMap

from analytics.models import daily_active_users


def _dau(events):
    return daily_active_users(events, IdentityMap.from_events(events))


def test_repeat_visits_on_one_day_count_once():
    events = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("web", "page_view", "2026-01-05", 2, user_id="u1"),
    ]
    assert _dau(events) == {"2026-01-05": 1}


def test_distinct_users_each_count():
    events = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("web", "page_view", "2026-01-05", 2, user_id="u2"),
        Event("mobile", "app_open", "2026-01-05", 3, device_id="d9"),
    ]
    assert _dau(events) == {"2026-01-05": 3}


def test_days_are_counted_separately_in_date_order():
    events = [
        Event("web", "page_view", "2026-01-06", 2, user_id="u1"),
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("web", "page_view", "2026-01-06", 3, user_id="u2"),
    ]
    assert list(_dau(events).items()) == [("2026-01-05", 1), ("2026-01-06", 2)]
