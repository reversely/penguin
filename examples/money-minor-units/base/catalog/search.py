"""Searching the catalog, with price bands for the search filters."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    shelf_price: float


def price_band(shelf_price: float) -> str:
    """The search filter band a shelf price falls in; each band includes its lower bound."""
    if shelf_price < 5:
        return "under-5"
    if shelf_price < 10:
        return "5-to-10"
    return "10-and-up"


def search(products: list[Product], query: str) -> list[str]:
    """The SKUs of the products whose name contains the query, ignoring case."""
    needle = query.casefold()
    return [product.sku for product in products if needle in product.name.casefold()]
