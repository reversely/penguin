from datetime import date

from disputes.deadlines import response_deadline


def test_each_network_has_its_own_window():
    opened = date(2026, 3, 2)
    assert response_deadline(opened, "visa") == date(2026, 3, 22)
    assert response_deadline(opened, "mastercard") == date(2026, 4, 16)
