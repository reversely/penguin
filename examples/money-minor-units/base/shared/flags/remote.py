"""Rollout percentages fetched from the flag service through the shared HTTP client."""

from shared.platform.http import Client, Timeout


def fetch_rollout(client: Client, flag: str) -> int | None:
    """The percent of stores ``flag`` is on for, or None when the flag service does not answer."""
    try:
        response = client.post("/v1/rollouts", {"flag": flag})
    except Timeout:
        return None
    return int(response.json["percent"])
