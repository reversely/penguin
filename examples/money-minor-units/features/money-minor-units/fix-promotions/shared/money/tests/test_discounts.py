from shared.money import Money
from shared.money.discounts import percent_off


def test_percentages_stack_on_what_is_left():
    assert percent_off(Money(1000, "USD"), 10, 5) == Money(855, "USD")


def test_no_percentage_keeps_the_amount():
    assert percent_off(Money(623, "USD")) == Money(623, "USD")


def test_yen_rounds_to_the_whole_yen():
    assert percent_off(Money(999, "JPY"), 15) == Money(849, "JPY")
