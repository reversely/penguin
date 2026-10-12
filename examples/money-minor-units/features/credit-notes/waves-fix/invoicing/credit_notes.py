"""Credit notes issued against an invoice."""

from shared.money import Money


def credit_note_line(sku: str, amount: Money) -> str:
    """A credit note row: the amount credited, shown as negative."""
    return f"Credit {sku}: -{amount.display()}"
