"""Each shopper's loyalty tier, from the orders the shopper placed this year."""

from collections import Counter
from collections.abc import Iterable

from accounts.shoppers import Event, ShopperMap
from loyalty.tiers import tier

ORDER_PLACED = "order_placed"


def tiers_by_shopper(
    events: Iterable[Event], shopper_map: ShopperMap
) -> dict[str, str]:
    """Each shopper's tier, keyed by the shopper the shopper map resolves each order to."""
    orders = Counter(
        shopper_map.resolve(event) for event in events if event.type == ORDER_PLACED
    )
    return {shopper: tier(orders[shopper]) for shopper in sorted(orders)}
