"""The tax on an order, rounded per line item."""

from decimal import Decimal

from orders.model import Line, Order, line_total
from shared import money
from tax.rates import rate_for


def line_tax(line: Line, rate: Decimal) -> money.Money:
    """The tax on one line, rounded to the currency's minor unit."""
    return line_total(line).scaled(rate)


def invoice_tax(order: Order) -> money.Money:
    """The tax on an order: each line's tax rounded to the minor unit, then summed."""
    rate = rate_for(order.region)
    return money.total([line_tax(line, rate) for line in order.lines])


def invoice_tax_minor(order: Order) -> int:
    """An order's tax in the currency's minor unit: what the invoice prints and the card charge carries."""
    return invoice_tax(order).amount_minor
