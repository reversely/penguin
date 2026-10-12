from accounts.backfill import backfill_shopper


def test_each_attribute_moves_under_the_shoppers_own_identity():
    """A stored shopper keeps every attribute after the backfill."""
    old = {
        "key": "device:d1",
        "identities": ["device:d1"],
        "attributes": {"email_subscribed": [4, False], "email": [1, "a@example.com"]},
    }
    assert backfill_shopper(old) == {
        "key": "device:d1",
        "identities": ["device:d1"],
        "by_identity": {
            "device:d1": {"email_subscribed": [4, False], "email": [1, "a@example.com"]}
        },
    }


def test_a_record_in_the_new_shape_is_unchanged():
    new = {"key": "user:u1", "identities": ["user:u1"], "by_identity": {"user:u1": {}}}
    assert backfill_shopper(new) is new
