from datetime import UTC, datetime, timedelta

from store_dashboard.holidays import closed_at, is_closed

LOS_ANGELES_WINTER = timedelta(hours=-8)


def test_store_is_closed_on_its_holidays():
    christmas_noon = datetime(2026, 12, 25, 20, 0, tzinfo=UTC)
    christmas_eve_noon = datetime(2026, 12, 24, 20, 0, tzinfo=UTC)
    assert is_closed(christmas_noon, LOS_ANGELES_WINTER, {"2026-12-25"})
    assert not is_closed(christmas_eve_noon, LOS_ANGELES_WINTER, {"2026-12-25"})


def test_a_closure_covers_the_stores_whole_local_day():
    """A holiday closure covers the store's whole local day."""
    # 20:00 on 25 December at UTC-08:00 is 04:00 UTC on 26 December.
    christmas_evening = datetime(2026, 12, 26, 4, 0, tzinfo=UTC)
    assert is_closed(christmas_evening, LOS_ANGELES_WINTER, {"2026-12-25"})


def test_closed_at_reads_iso_text():
    assert closed_at(
        ["2026-12-25T20:00:00+00:00", "2026-12-24T20:00:00+00:00"],
        "-08:00",
        ["2026-12-25"],
    ) == {"2026-12-25T20:00:00+00:00": True, "2026-12-24T20:00:00+00:00": False}
