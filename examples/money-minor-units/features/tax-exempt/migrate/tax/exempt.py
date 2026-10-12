"""Tax-exempt customers, such as schools and charities."""

from orders.model import Order
from tax.invoice import invoice_tax


def tax_due(order: Order, exempt: bool) -> float:
    """The tax an order owes: nothing for a tax-exempt customer."""
    return 0.0 if exempt else invoice_tax(order)
