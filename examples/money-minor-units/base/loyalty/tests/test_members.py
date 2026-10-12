from accounts.shoppers import Event, ShopperMap
from loyalty.members import tiers_by_shopper


def _order(ts, **ids):
    return Event("web", "order_placed", "2026-01-05", ts, **ids)


def test_a_tier_counts_every_order_the_shopper_placed():
    """A shopper's tier counts every order the shopper placed this year."""
    events = [_order(ts, user_id="u1") for ts in range(20)] + [_order(20, user_id="u2")]
    assert tiers_by_shopper(events, ShopperMap.from_events(events)) == {
        "user:u1": "silver",
        "user:u2": "member",
    }
