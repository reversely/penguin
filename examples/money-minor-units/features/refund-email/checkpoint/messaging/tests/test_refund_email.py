from messaging.refund_email import refund_email


def test_email_names_the_refund():
    assert refund_email("o-1", 2.98) == "We refunded $2.98 for order o-1."
