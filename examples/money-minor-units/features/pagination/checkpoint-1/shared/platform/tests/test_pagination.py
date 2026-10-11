from shared.platform.pagination import page


def test_pages_until_the_last_item():
    assert page([1, 2, 3], 0, 2) == ([1, 2], 2)
    assert page([1, 2, 3], 2, 2) == ([3], None)
