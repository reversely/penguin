from datetime import UTC, datetime, timedelta

from messaging.contacts import Contact, local_timezone


def test_local_timezone_converts_an_instant_to_the_contact_offset():
    contact = Contact("u1", "u1@example.invalid", timedelta(hours=-8))
    moment = datetime(2026, 2, 10, 4, 30, tzinfo=UTC)
    assert moment.astimezone(local_timezone(contact)).isoformat() == (
        "2026-02-09T20:30:00-08:00"
    )
