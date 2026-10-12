"""Saved cards as checkout shows and checks them."""


def masked(number: str) -> str:
    """A card number as a shopper sees it: only the last four digits."""
    digits = number.replace(" ", "")
    return f"**** {digits[-4:]}"


def is_expired(month: int, year: int, today_month: int, today_year: int) -> bool:
    """Whether a card is past its expiry month."""
    return (year, month) < (today_year, today_month)
