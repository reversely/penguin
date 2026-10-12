from shared.money import Money
from shared.money.discounts import discounted


def test_percentages_stack_on_what_is_left():
    assert discounted(Money(1000, "USD"), 10, 5) == Money(855, "USD")


def test_no_percentage_keeps_the_amount():
    assert discounted(Money(623, "USD")) == Money(623, "USD")
