"""Coupon codes and the percentage each takes off."""

COUPONS = {"WELCOME10": 10, "FRESH5": 5, "BULK15": 15}


def coupon_percent(code: str) -> int:
    """The percentage a coupon takes off; 0 for a code Larder does not issue."""
    return COUPONS.get(code.strip().upper(), 0)
