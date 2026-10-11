"""Log lines as JSON objects with sorted keys."""

import json


def log_line(event: str, **fields: object) -> str:
    """One log line: the event and its fields, keys sorted so lines diff cleanly."""
    return json.dumps({"event": event, **fields}, sort_keys=True)
