"""The email sent when a refund is issued."""

from shared import money


def refund_email(order_id: str, amount: money.Money) -> str:
    """The email's text."""
    return f"We refunded {amount.display()} for order {order_id}."
