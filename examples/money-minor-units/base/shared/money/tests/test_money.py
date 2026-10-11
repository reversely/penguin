from shared import money
from shared.money.discounts import percent_off


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
