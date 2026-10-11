from shared.platform.retry import may_retry


def test_only_idempotent_requests_retry():
    assert may_retry("get", 1)
    assert not may_retry("POST", 1)


def test_retries_stop_at_the_limit():
    assert not may_retry("GET", 3)
