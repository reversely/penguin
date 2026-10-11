"""Shipping rate quotes from the carrier's rates API."""

from shared.http import Client


class QuoteError(Exception):
    """The carrier refused the quote request."""


def quote(client: Client, weight_grams: int, destination: str) -> int:
    """Return the carrier's rate in cents for a parcel of ``weight_grams`` to ``destination``."""
    response = client.post(
        "/v1/rates", {"weight_grams": weight_grams, "destination": destination}
    )
    if response.status != 200:
        raise QuoteError(f"carrier answered {response.status}")
    return response.json["amount_cents"]
