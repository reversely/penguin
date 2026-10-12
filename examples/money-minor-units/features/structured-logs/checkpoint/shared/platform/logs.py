"""Log lines as JSON objects with sorted keys, filed under the UTC day they were written."""

import json
from datetime import datetime

from shared.platform.dates import start_of_day


def log_line(event: str, **fields: object) -> str:
    """One log line: the event and its fields, keys sorted so lines diff cleanly."""
    return json.dumps({"event": event, **fields}, sort_keys=True)


def log_day(written: datetime) -> str:
    """The ISO date of the log partition a line written at ``written`` goes into."""
    return start_of_day(written).date().isoformat()
