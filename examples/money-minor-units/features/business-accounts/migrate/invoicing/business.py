"""Monthly statements for business accounts."""

from invoicing.invoice import amount_due_cents
from orders.model import Order
from shared.money import Money


def statement_total(orders: list[Order]) -> float:
    """What a business account owes for the month: the total due on each of its invoices."""
    due = [Money(amount_due_cents(order), order.currency) for order in orders]
    return float(Money.sum(due).major())
