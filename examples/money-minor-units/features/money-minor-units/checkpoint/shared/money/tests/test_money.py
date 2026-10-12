from decimal import Decimal

import pytest

from shared import money
from shared.money import Money
from shared.money.discounts import discounted, percent_off


def test_price_rounds_to_the_cent():
    assert money.price(2.675) == 2.68
    assert money.price(2.5) == 2.5


def test_total_sums_and_rounds_to_the_cent():
    assert money.total([0.1, 0.2]) == 0.3


def test_display_shows_dollars_and_cents():
    assert money.display(1234.5) == "$1,234.50"


def test_percent_off_rounds_to_the_cent():
    assert percent_off(10.0, 15) == 8.5
    assert percent_off(0.99, 10) == 0.89


def test_money_is_a_whole_number_of_minor_units():
    assert Money(1299, "USD").amount_minor == 1299
    with pytest.raises(TypeError):
        # A float on purpose: Money refuses anything but whole minor units.
        Money(12.99, "USD")  # pyright: ignore[reportArgumentType]


def test_sum_adds_one_currency():
    assert Money.sum([Money(10, "USD"), Money(20, "USD")]) == Money(30, "USD")
    with pytest.raises(ValueError):
        Money.sum([Money(10, "USD"), Money(10, "JPY")])


def test_from_major_uses_the_currencys_minor_unit():
    assert Money.from_major("10", "USD") == Money(1000, "USD")
    assert Money.from_major("10", "JPY") == Money(10, "JPY")


def test_scaled_rounds_to_the_minor_unit():
    assert Money(25, "USD").scaled("0.31") == Money(8, "USD")


def test_major_is_the_exact_amount_in_major_units():
    assert Money(1299, "USD").major() == Decimal("12.99")
    assert Money(1000, "JPY").major() == Decimal(1000)


def test_display_shows_each_currencys_digits():
    assert Money(123450, "USD").display() == "$1,234.50"
    assert Money(1000, "JPY").display() == "¥1,000"


def test_discounted_rounds_to_the_minor_unit_once():
    assert discounted(Money(1000, "USD"), 15) == Money(850, "USD")
    assert discounted(Money(623, "USD"), 10, 5) == Money(533, "USD")
