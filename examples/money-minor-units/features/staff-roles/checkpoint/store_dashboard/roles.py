"""What each member of a store's staff may change on the dashboard."""

EDITS_HOURS = frozenset({"owner", "manager"})


def can_edit_hours(role: str) -> bool:
    """Whether a staff role may change the store's opening hours."""
    return role in EDITS_HOURS
