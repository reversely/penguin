from fulfilment.picking import pick_list, slots_left
from orders.model import Order


def test_pick_list_merges_repeated_skus():
    order = Order.from_record(
        {
            "id": "o1",
            "region": "NY",
            "currency": "USD",
            "lines": [
                {"sku": "milk", "quantity": 1, "unit_price": "1.49"},
                {"sku": "eggs", "quantity": 2, "unit_price": "3.20"},
                {"sku": "milk", "quantity": 2, "unit_price": "1.49"},
            ],
        }
    )
    assert pick_list(order) == [("eggs", 2), ("milk", 3)]


def test_a_full_window_has_no_slots():
    assert slots_left(10, 12) == 0
