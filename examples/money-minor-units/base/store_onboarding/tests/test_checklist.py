from store_onboarding.checklist import hours_step_summary, missing_steps


def test_missing_steps_keep_their_order():
    assert missing_steps({"opening-hours"}) == [
        "bank-account",
        "first-products",
        "staff-invite",
    ]


def test_hours_step_reads_the_dashboard_label():
    assert hours_step_summary(8, 22) == "Opening hours set: 08:00-22:00"
