from orders.model import Line, Order, line_total, order_total

RECORD = {
    "id": "o-1",
    "region": "NY",
    "currency": "USD",
    "lines": [
        {"sku": "milk", "quantity": 2, "unit_price": 1.49},
        {"sku": "bread", "quantity": 1, "unit_price": 3.25},
    ],
}


def test_from_record_reads_the_stored_prices():
    assert Order.from_record(RECORD).lines[0] == Line("milk", 2, 1.49)


def test_line_total_is_price_times_quantity():
    assert line_total(Line("milk", 2, 1.49)) == 2.98


def test_order_total_sums_the_lines():
    assert order_total(Order.from_record(RECORD)) == 6.23
