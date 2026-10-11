"""Allergen tags on products, read from their ingredients."""

ALLERGENS = {"milk": "dairy", "wheat": "gluten", "peanut": "peanuts", "egg": "eggs"}


def allergen_tags(ingredients: list[str]) -> set[str]:
    """The allergen tags a product carries."""
    return {ALLERGENS[item] for item in ingredients if item in ALLERGENS}
