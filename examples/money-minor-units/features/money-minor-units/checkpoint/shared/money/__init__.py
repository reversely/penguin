"""Prices as whole numbers of a currency's minor unit, and the arithmetic every scope uses on them.

The cent is the US dollar's minor unit, so ``Money(1000, "USD")`` is 10 dollars. The yen has no
minor unit, so ``Money(10, "JPY")`` is 10 yen.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from shared.money.rounding import ROUNDING

# Digits after the decimal point in each currency's minor unit (ISO 4217).
MINOR_DIGITS = {"USD": 2, "EUR": 2, "GBP": 2, "JPY": 0}
SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}


@dataclass(frozen=True)
class Money:
    amount_minor: int
    currency: str

    def __post_init__(self) -> None:
        if self.currency not in MINOR_DIGITS:
            raise ValueError(f"unknown currency {self.currency!r}")
        if type(self.amount_minor) is not int:
            raise TypeError(f"amount_minor must be an int, got {self.amount_minor!r}")

    @classmethod
    def from_major(cls, amount: str, currency: str) -> Money:
        """Money from an amount in major units written as a decimal, such as "12.99" dollars."""
        minor = Decimal(amount).scaleb(MINOR_DIGITS[currency])
        return cls(int(minor.quantize(Decimal(1), rounding=ROUNDING)), currency)

    def __add__(self, other: Money) -> Money:
        return Money(self.amount_minor + self._same(other).amount_minor, self.currency)

    def __sub__(self, other: Money) -> Money:
        return Money(self.amount_minor - self._same(other).amount_minor, self.currency)

    def times(self, quantity: int) -> Money:
        """This amount ``quantity`` times over."""
        return Money(self.amount_minor * quantity, self.currency)

    def scaled(self, factor: Decimal | int | str) -> Money:
        """This amount times ``factor``, rounded to the minor unit."""
        exact = Decimal(self.amount_minor) * Decimal(factor)
        return Money(int(exact.quantize(Decimal(1), rounding=ROUNDING)), self.currency)

    def display(self) -> str:
        """The amount for a person to read, such as ``$1,234.50`` or ``¥1,000``."""
        digits = MINOR_DIGITS[self.currency]
        major = Decimal(self.amount_minor).scaleb(-digits)
        sign = "-" if major < 0 else ""
        return f"{sign}{SYMBOLS[self.currency]}{abs(major):,.{digits}f}"

    def _same(self, other: Money) -> Money:
        if other.currency != self.currency:
            raise ValueError(f"cannot combine {self.currency} with {other.currency}")
        return other


def price(amount_minor: int, currency: str) -> Money:
    """A price of ``amount_minor`` in the currency's minor unit."""
    return Money(amount_minor, currency)


def total(prices: list[Money]) -> Money:
    """The sum of prices in one currency. A total of no prices has no currency, so it is refused."""
    if not prices:
        raise ValueError("a total needs at least one price")
    result = prices[0]
    for item in prices[1:]:
        result = result + item
    return result
