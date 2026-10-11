"""Product image URLs at the sizes the apps request."""

SIZES = {"thumb": 120, "card": 480, "full": 1200}


def image_url(sku: str, size: str) -> str:
    """The path of a product image at a named size."""
    return f"/images/{sku}/{SIZES[size]}.webp"
