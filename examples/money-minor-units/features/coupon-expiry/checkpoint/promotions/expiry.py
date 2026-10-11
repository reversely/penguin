"""Coupons that stop working after a date."""


def is_expired(code: str, today: str, expiries: dict[str, str]) -> bool:
    """Whether a coupon has expired; ``today`` and each expiry are ISO dates."""
    return code in expiries and today > expiries[code]
