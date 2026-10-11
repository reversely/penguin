from store_dashboard.stock import low_stock


def test_alerts_list_items_under_the_threshold():
    assert low_stock({"milk": 2, "bread": 9, "eggs": 4}) == ["eggs", "milk"]
