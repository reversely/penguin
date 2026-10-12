"""The currencies Larder sells in, with each one's minor unit."""

# Digits after the decimal point in each currency's minor unit (ISO 4217).
MINOR_DIGITS = {"USD": 2, "CAD": 2, "EUR": 2, "GBP": 2, "JPY": 0}


def minor_digits(code: str) -> int:
    """The number of digits after the decimal point in the currency's minor unit."""
    return MINOR_DIGITS[code.upper()]


def is_supported(code: str) -> bool:
    """Whether Larder sells in the currency."""
    return code.upper() in MINOR_DIGITS
