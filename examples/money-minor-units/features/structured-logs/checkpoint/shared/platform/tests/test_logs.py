from shared.platform.logs import log_line


def test_log_keys_are_sorted():
    assert log_line("order.placed", store="s-1", items=3) == (
        '{"event": "order.placed", "items": 3, "store": "s-1"}'
    )
