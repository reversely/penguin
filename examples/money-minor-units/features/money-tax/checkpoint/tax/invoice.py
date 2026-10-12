"""The tax on an order, in the order's currency."""

from orders.model import Order, line_total_minor
from shared.money import Money
from tax.rates import rate_for


def invoice_tax(order: Order) -> Money:
    """The tax on an order: the order's subtotal times its region's rate, rounded once."""
    subtotal = Money.sum(
        [line_total_minor(line, order.currency) for line in order.lines]
    )
    return subtotal.scaled(rate_for(order.region))


def invoice_tax_minor(order: Order) -> int:
    """An order's tax in the currency's minor unit: what the invoice prints and the card charge carries."""
    return invoice_tax(order).amount_minor
