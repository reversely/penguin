from analytics.league import league_table


def test_stores_rank_by_revenue():
    """Stores rank by revenue from highest to lowest."""
    assert league_table({"Corner Grocer": 120.5, "Fresh Fields": 980.0}) == [
        "1. Fresh Fields $980.00",
        "2. Corner Grocer $120.50",
    ]
