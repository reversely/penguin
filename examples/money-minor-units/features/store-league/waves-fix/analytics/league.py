"""The league table of stores by revenue."""

from shared.money import Money


def league_table(revenue_by_store: dict[str, Money]) -> list[str]:
    """Stores ranked by revenue, highest first; every store's revenue is in one currency."""
    ranked = sorted(
        revenue_by_store.items(), key=lambda item: (-item[1].amount_minor, item[0])
    )
    return [
        f"{rank}. {store} {amount.display()}"
        for rank, (store, amount) in enumerate(ranked, start=1)
    ]
