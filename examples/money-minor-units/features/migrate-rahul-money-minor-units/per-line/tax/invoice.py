"""The tax on an order, rounded per line item."""

from decimal import Decimal

from orders.model import Line, Order, line_total_minor
from shared.money import Money
from tax.rates import rate_for


def line_tax(line: Line, rate: float) -> float:
    """The tax on one line, rounded to the cent."""
    return float(line_total_minor(line, "USD").scaled(Decimal(repr(rate))).major())


def _tax(order: Order) -> Money:
    """Each line's tax rounded to the minor unit, then summed."""
    rate = Decimal(repr(rate_for(order.region)))
    taxes = [
        line_total_minor(line, order.currency).scaled(rate) for line in order.lines
    ]
    return Money.sum(taxes) if taxes else Money(0, order.currency)


def invoice_tax(order: Order) -> float:
    """The tax on an order, in dollars: each line's tax rounded to the cent, then summed."""
    return float(_tax(order).major())


def invoice_tax_minor(order: Order) -> int:
    """An order's tax in cents: the amount the invoice prints and the card charge carries."""
    return _tax(order).amount_minor
