"""Search synonyms, so "courgette" also finds "zucchini"."""

SYNONYMS = {
    "courgette": ["zucchini"],
    "aubergine": ["eggplant"],
    "coriander": ["cilantro"],
}


def expand(query: str) -> list[str]:
    """The query and every synonym of it."""
    word = query.casefold()
    return [word, *SYNONYMS.get(word, [])]
