"""The deadline for answering a card dispute."""

from datetime import date, timedelta

# Days a merchant has to send evidence after a dispute opens, by card network.
RESPONSE_DAYS = {"visa": 20, "mastercard": 45, "amex": 20}


def response_deadline(opened: date, network: str) -> date:
    """The last day evidence for a dispute can be sent."""
    return opened + timedelta(days=RESPONSE_DAYS[network])
