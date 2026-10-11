from catalog.search import Product, price_band, search

PRODUCTS = [Product("milk", "Whole milk", 1.49), Product("oat", "Oat milk", 3.99)]


def test_price_bands_include_their_lower_bound():
    assert price_band(4.99) == "under-5"
    assert price_band(5.0) == "5-to-10"
    assert price_band(10.0) == "10-and-up"


def test_search_ignores_case():
    assert search(PRODUCTS, "MILK") == ["milk", "oat"]
