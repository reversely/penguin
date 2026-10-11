from analytics.league import league_table
from shared.money import Money


def test_stores_rank_by_revenue():
    revenue = {
        "Corner Grocer": Money(12050, "USD"),
        "Fresh Fields": Money(98000, "USD"),
    }
    assert league_table(revenue) == [
        "1. Fresh Fields $980.00",
        "2. Corner Grocer $120.50",
    ]
