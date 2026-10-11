from messaging.refund_email import refund_email
from shared.money import Money


def test_email_names_the_refund():
    assert refund_email("o-1", Money(298, "USD")) == "We refunded $2.98 for order o-1."
