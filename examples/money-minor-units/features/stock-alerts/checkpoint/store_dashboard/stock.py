"""Alerts for items running low."""


def low_stock(levels: dict[str, int], threshold: int = 5) -> list[str]:
    """The SKUs with fewer than ``threshold`` units left, in order."""
    return sorted(sku for sku, units in levels.items() if units < threshold)
