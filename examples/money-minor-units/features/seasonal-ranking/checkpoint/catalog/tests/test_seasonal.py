from catalog.seasonal import in_season


def test_winter_season_wraps_past_december():
    assert in_season(1, (11, 2))
    assert not in_season(6, (11, 2))
