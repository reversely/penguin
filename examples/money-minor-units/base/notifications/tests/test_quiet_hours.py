from notifications.quiet_hours import in_quiet_hours


def test_quiet_hours_wrap_past_midnight():
    assert in_quiet_hours(23, start=22, end=7)
    assert in_quiet_hours(6, start=22, end=7)
    assert not in_quiet_hours(7, start=22, end=7)
