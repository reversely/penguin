from inventory.stock import available


def test_reserved_units_are_not_for_sale():
    assert available(12, 5) == 7
    assert available(3, 5) == 0
