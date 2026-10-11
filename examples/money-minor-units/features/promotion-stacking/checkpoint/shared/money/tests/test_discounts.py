from shared.money.discounts import percent_off


def test_percentages_stack_on_what_is_left():
    assert percent_off(10.0, 10, 5) == 8.55


def test_no_percentage_keeps_the_amount():
    assert percent_off(6.23) == 6.23
