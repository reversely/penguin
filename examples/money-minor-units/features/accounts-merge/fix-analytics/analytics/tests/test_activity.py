from accounts.shoppers import Event, ShopperMap
from analytics.activity import daily_active_users


def _dau(events):
    return daily_active_users(events, ShopperMap.from_events(events))


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


def test_published_day_keeps_its_count_after_a_later_login():
    """A published day's daily active users stay the same when later days' events arrive."""
    published = [
        Event("web", "page_view", "2026-01-05", 1, user_id="u1"),
        Event("mobile", "app_open", "2026-01-05", 2, device_id="d1"),
    ]
    later = [
        Event("mobile", "login", "2026-01-06", 3, user_id="u1", device_id="d1"),
    ]
    assert _dau(published) == {"2026-01-05": 2}
    assert _dau(published + later) == {"2026-01-05": 2, "2026-01-06": 1}
