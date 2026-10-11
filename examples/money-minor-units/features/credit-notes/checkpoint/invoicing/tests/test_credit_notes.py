from invoicing.credit_notes import credit_note_line


def test_credit_is_shown_as_negative():
    """A credit note shows the credited amount as negative."""
    assert credit_note_line("milk", 1.49) == "Credit milk: -$1.49"
