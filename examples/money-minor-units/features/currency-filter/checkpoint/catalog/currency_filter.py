"""Search filters for prices in the shopper's currency, written against Money from the start."""

from __future__ import annotations

from shared import money


def priced_in(prices: dict[str, money.Money], currency: str) -> list[str]:
    """The SKUs priced in ``currency``, in order."""
    return sorted(sku for sku, price in prices.items() if price.currency == currency)


def price_filter_label(low: money.Money, high: money.Money) -> str:
    """The label of a price range filter, such as ``¥100 to ¥500``."""
    return f"{low.display()} to {high.display()}"
