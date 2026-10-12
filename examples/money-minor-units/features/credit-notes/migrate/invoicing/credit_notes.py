"""Credit notes issued against an invoice."""

from shared.money import Money


def credit_note_line(sku: str, amount: float) -> str:
    """A credit note row: the amount credited, shown as negative."""
    return f"Credit {sku}: -{Money.from_major(str(amount), 'USD').display()}"
