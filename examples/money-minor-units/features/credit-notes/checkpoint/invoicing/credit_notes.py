"""Credit notes issued against an invoice."""

from shared import money


def credit_note_line(sku: str, amount: float) -> str:
    """A credit note row: the amount credited, shown as negative."""
    return f"Credit {sku}: -{money.display(money.price(amount))}"
