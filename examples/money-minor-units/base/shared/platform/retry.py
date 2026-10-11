"""Retrying idempotent requests."""

IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE"})


def may_retry(method: str, attempt: int, max_attempts: int = 3) -> bool:
    """Whether a failed request may be sent again: idempotent and under the attempt limit."""
    return method.upper() in IDEMPOTENT_METHODS and attempt < max_attempts
