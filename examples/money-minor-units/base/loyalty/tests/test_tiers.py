from loyalty.tiers import tier


def test_thresholds_include_their_lower_bound():
    assert tier(0) == "member"
    assert tier(20) == "silver"
    assert tier(50) == "gold"
