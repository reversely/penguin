from shared.platform.budget import retries_left


def test_budget_never_goes_negative():
    assert retries_left(10, 3) == 7
    assert retries_left(10, 12) == 0
