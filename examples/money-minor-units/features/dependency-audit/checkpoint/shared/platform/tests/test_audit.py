from shared.platform.audit import outdated


def test_audit_lists_packages_behind_latest():
    pinned = {"httpx": "0.27.0", "pytest": "9.1.1"}
    assert outdated(pinned, {"httpx": "0.28.1", "pytest": "9.1.1"}) == ["httpx"]
