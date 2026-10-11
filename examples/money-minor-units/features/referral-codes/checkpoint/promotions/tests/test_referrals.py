from promotions.referrals import referral_code


def test_code_is_built_from_the_customer_id():
    assert referral_code("c-42") == "FRIEND-C-42"
