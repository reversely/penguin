import pytest

from shared import money
from shared.money import Money
from shared.money.discounts import percent_off


def test_price_is_a_whole_number_of_minor_units():
    assert money.price(1299, "USD") == Money(1299, "USD")
    with pytest.raises(TypeError):
        Money(12.99, "USD")


def test_total_sums_one_currency():
    assert money.total([Money(10, "USD"), Money(20, "USD")]) == Money(30, "USD")
    with pytest.raises(ValueError):
        money.total([Money(10, "USD"), Money(10, "JPY")])


def test_from_major_uses_the_currencys_minor_unit():
    assert Money.from_major("10", "USD") == Money(1000, "USD")
    assert Money.from_major("10", "JPY") == Money(10, "JPY")


def test_scaled_rounds_to_the_minor_unit():
    assert Money(25, "USD").scaled("0.31") == Money(8, "USD")


def test_display_shows_each_currencys_digits():
    assert Money(123450, "USD").display() == "$1,234.50"
    assert Money(1000, "JPY").display() == "¥1,000"


def test_percent_off_rounds_to_the_cent():
    assert percent_off(10.0, 15) == 8.5
    assert percent_off(0.99, 10) == 0.89
