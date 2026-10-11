from payments.orders import Order, charge_body


def test_charge_body_carries_the_order_amount_and_currency():
    order = Order("ord_1001", "cus_7", 4999)
    assert charge_body(order) == {
        "order_id": "ord_1001",
        "customer_id": "cus_7",
        "amount_cents": 4999,
        "currency": "GBP",
    }
