"""Referral codes customers share with friends."""


def referral_code(customer_id: str) -> str:
    """A customer's referral code: a fixed prefix and the customer's id in capitals."""
    return f"FRIEND-{customer_id.upper()}"
