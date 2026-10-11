from catalog.currency_filter import price_filter_label, priced_in
from shared import money


def test_filter_keeps_one_currency():
    prices = {"onigiri": money.Money(150, "JPY"), "milk": money.Money(149, "USD")}
    assert priced_in(prices, "JPY") == ["onigiri"]


def test_filter_label_uses_each_currencys_digits():
    low, high = money.Money(100, "JPY"), money.Money(500, "JPY")
    assert price_filter_label(low, high) == "¥100 to ¥500"
