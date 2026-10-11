from store_dashboard.roles import can_edit_hours


def test_only_owners_and_managers_edit_hours():
    assert can_edit_hours("manager")
    assert not can_edit_hours("picker")
