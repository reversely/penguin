"""Monthly statements for business accounts."""

from invoicing.invoice import amount_due
from orders.model import Order
from shared import money


def statement_total(orders: list[Order]) -> money.Money:
    """What a business account owes for the month: the total due on each of its invoices."""
    return money.total([amount_due(order) for order in orders])
