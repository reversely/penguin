"""Contacts that messaging sends to."""

from dataclasses import dataclass
from datetime import timedelta, timezone


@dataclass(frozen=True)
class Contact:
    """A user that messaging can reach, with the UTC offset of the user's home timezone."""

    user_id: str
    email: str
    utc_offset: timedelta


def local_timezone(contact: Contact) -> timezone:
    """Return the fixed-offset timezone of a contact."""
    return timezone(contact.utc_offset)
