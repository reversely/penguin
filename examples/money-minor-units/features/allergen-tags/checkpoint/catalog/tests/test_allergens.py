from catalog.allergens import allergen_tags


def test_tags_come_from_the_ingredients():
    assert allergen_tags(["wheat", "water", "egg"]) == {"gluten", "eggs"}
