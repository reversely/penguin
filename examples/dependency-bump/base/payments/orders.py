"""Orders awaiting payment."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Order:
    id: str
    customer_id: str
    amount_cents: int
    currency: str = "GBP"


def charge_body(order: Order) -> dict:
    """Return the payment processor's charge request body for ``order``."""
    return {
        "order_id": order.id,
        "customer_id": order.customer_id,
        "amount_cents": order.amount_cents,
        "currency": order.currency,
    }
