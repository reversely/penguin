from app_config.versions import is_supported


def test_versions_compare_as_numbers():
    assert is_supported("4.12.0", "4.9.3")
    assert not is_supported("4.9.2", "4.9.3")
