"""Assigning shoppers to an experiment's arms."""

import hashlib


def bucket(shopper_id: str, experiment: str, arms: int) -> int:
    """The arm a shopper sees: the same for every visit, spread evenly across shoppers."""
    digest = hashlib.sha256(f"{experiment}:{shopper_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % arms
