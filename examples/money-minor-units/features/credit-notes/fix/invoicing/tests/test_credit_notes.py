from invoicing.credit_notes import credit_note_line
from shared.money import Money


def test_credit_is_shown_as_negative():
    assert credit_note_line("milk", Money(149, "USD")) == "Credit milk: -$1.49"
