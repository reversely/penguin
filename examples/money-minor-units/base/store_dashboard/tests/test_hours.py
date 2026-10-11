from store_dashboard.hours import hours_label, is_open


def test_late_close_wraps_past_midnight():
    assert is_open(1, opens=18, closes=2)
    assert not is_open(3, opens=18, closes=2)


def test_hours_label_pads_hours():
    assert hours_label(8, 22) == "08:00-22:00"
