"""When each shopper's weekly digest goes out: at the shopper's local hour."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone

from shared.platform.dates import start_of_day


@dataclass(frozen=True)
class Recipient:
    """A shopper the digest goes to, with the UTC offset of the shopper's home timezone."""

    shopper_id: str
    email: str
    utc_offset: timedelta


def next_send(recipient: Recipient, now: datetime, local_hour: int) -> datetime:
    """The first instant after ``now`` at which the shopper's local time is ``local_hour``:00, in UTC."""
    local_now = now.astimezone(timezone(recipient.utc_offset))
    send = start_of_day(local_now) + timedelta(hours=local_hour)
    if send <= now:
        send += timedelta(days=1)
    return send.astimezone(UTC)


def send_times(
    recipients: Iterable[Recipient], now: datetime, local_hour: int
) -> dict[str, str]:
    """Each shopper's next send as an ISO 8601 UTC instant, keyed by ``shopper_id`` in order.

    The send queue stores these strings.
    """
    return {
        recipient.shopper_id: next_send(recipient, now, local_hour).isoformat()
        for recipient in sorted(recipients, key=lambda recipient: recipient.shopper_id)
    }
