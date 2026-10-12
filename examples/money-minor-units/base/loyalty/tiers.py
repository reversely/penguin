"""Loyalty tiers by how many orders a shopper placed this year."""

TIERS = ((50, "gold"), (20, "silver"), (0, "member"))


def tier(orders_this_year: int) -> str:
    """The shopper's tier: the highest whose threshold the order count reaches."""
    return next(name for threshold, name in TIERS if orders_this_year >= threshold)
