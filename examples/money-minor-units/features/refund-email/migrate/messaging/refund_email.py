"""The email sent when a refund is issued."""

from shared.money import Money


def refund_email(order_id: str, amount: float) -> str:
    """The email's text."""
    refunded = Money.from_major(str(amount), "USD").display()
    return f"We refunded {refunded} for order {order_id}."
