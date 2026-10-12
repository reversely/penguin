"""The tax on an order, rounded once on the order's subtotal."""

from decimal import Decimal

from orders.model import Line, Order, line_total_minor, order_total_minor
from shared.money import Money
from tax.rates import rate_for


def line_tax(line: Line, rate: float) -> float:
    """The tax on one line, rounded to the cent."""
    return float(line_total_minor(line, "USD").scaled(Decimal(repr(rate))).major())


def _tax(order: Order) -> Money:
    """The order's subtotal times its region's rate, rounded once to the minor unit."""
    return order_total_minor(order).scaled(Decimal(repr(rate_for(order.region))))


def invoice_tax(order: Order) -> float:
    """The tax on an order, in dollars."""
    return float(_tax(order).major())


def invoice_tax_minor(order: Order) -> int:
    """An order's tax in cents: the amount the invoice prints and the card charge carries."""
    return _tax(order).amount_minor
