from shared.flags.rollout import enabled


def test_zero_and_full_rollouts():
    assert not enabled("new-hours", "store-1", 0)
    assert enabled("new-hours", "store-1", 100)


def test_a_store_keeps_its_answer():
    assert enabled("new-hours", "store-7", 40) == enabled("new-hours", "store-7", 40)
