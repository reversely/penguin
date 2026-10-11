"""The league table of stores by revenue."""

from shared import money


def league_table(revenue_by_store: dict[str, float]) -> list[str]:
    """Stores ranked by revenue, highest first."""
    ranked = sorted(revenue_by_store.items(), key=lambda item: (-item[1], item[0]))
    return [
        f"{rank}. {store} {money.display(amount)}"
        for rank, (store, amount) in enumerate(ranked, start=1)
    ]
