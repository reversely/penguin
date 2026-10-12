from experiments.buckets import bucket


def test_a_shopper_keeps_their_arm():
    assert bucket("s-1", "new-basket", 2) == bucket("s-1", "new-basket", 2)


def test_every_arm_gets_shoppers():
    arms = {bucket(f"s-{n}", "new-basket", 3) for n in range(60)}
    assert arms == {0, 1, 2}
