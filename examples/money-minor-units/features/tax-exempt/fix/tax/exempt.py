"""Tax-exempt customers, such as schools and charities."""

from orders.model import Order
from shared import money
from tax.invoice import invoice_tax


def tax_due(order: Order, exempt: bool) -> money.Money:
    """The tax an order owes: nothing for a tax-exempt customer."""
    return money.price(0, order.currency) if exempt else invoice_tax(order)
