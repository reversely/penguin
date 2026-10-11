"""The email sent when a refund is issued."""

from shared import money


def refund_email(order_id: str, amount: float) -> str:
    """The email's text."""
    return f"We refunded {money.display(money.price(amount))} for order {order_id}."
