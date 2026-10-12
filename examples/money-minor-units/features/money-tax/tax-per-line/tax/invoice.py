"""The tax on an order, rounded per line item."""

from decimal import Decimal

from orders.model import Line, Order, line_total_minor
from shared.money import Money
from tax.rates import rate_for


def line_tax(line: Line, currency: str, rate: Decimal) -> Money:
    """The tax on one line, rounded to the currency's minor unit."""
    return line_total_minor(line, currency).scaled(rate)


def invoice_tax(order: Order) -> Money:
    """The tax on an order: each line's tax rounded to the minor unit, then summed."""
    rate = rate_for(order.region)
    return Money.sum([line_tax(line, order.currency, rate) for line in order.lines])


def invoice_tax_minor(order: Order) -> int:
    """An order's tax in the currency's minor unit: what the invoice prints and the card charge carries."""
    return invoice_tax(order).amount_minor
