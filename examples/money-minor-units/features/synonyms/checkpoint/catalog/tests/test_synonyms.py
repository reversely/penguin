from catalog.synonyms import expand


def test_query_expands_to_its_synonyms():
    assert expand("Courgette") == ["courgette", "zucchini"]
    assert expand("milk") == ["milk"]
