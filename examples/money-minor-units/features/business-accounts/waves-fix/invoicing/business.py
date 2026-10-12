"""Monthly statements for business accounts."""

from invoicing.invoice import amount_due
from orders.model import Order
from shared.money import Money


def statement_total(orders: list[Order]) -> Money:
    """What a business account owes for the month: the total due on each of its invoices."""
    return Money.sum([amount_due(order) for order in orders])
