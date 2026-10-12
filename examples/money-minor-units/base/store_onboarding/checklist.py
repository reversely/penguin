"""The steps a new store completes before it goes live."""

from store_dashboard.hours import hours_label

STEPS = ("bank-account", "opening-hours", "first-products", "staff-invite")


def missing_steps(done: set[str]) -> list[str]:
    """The steps the store has not completed yet, in order."""
    return [step for step in STEPS if step not in done]


def hours_step_summary(opens: int, closes: int) -> str:
    """The opening-hours step as the checklist shows it once done."""
    return f"Opening hours set: {hours_label(opens, closes)}"
