"""The tax on an order, rounded per line item."""

from orders.model import Line, Order
from shared import money
from tax.rates import rate_for


def line_tax(line: Line, rate: float) -> float:
    """The tax on one line, rounded to the cent."""
    return money.price(line.unit_price * line.quantity * rate)


def invoice_tax(order: Order) -> float:
    """The tax on an order: each line's tax rounded to the cent, then summed."""
    rate = rate_for(order.region)
    return money.total([line_tax(line, rate) for line in order.lines])


def invoice_tax_minor(order: Order) -> int:
    """An order's tax in cents: the amount the invoice prints and the card charge carries."""
    return round(invoice_tax(order) * 100)
