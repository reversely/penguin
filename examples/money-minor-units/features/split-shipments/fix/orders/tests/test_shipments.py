from orders.model import Line, Order
from orders.shipments import shipment_total
from shared.money import Money

ORDER = Order(
    "o-1",
    "NY",
    "USD",
    [Line("milk", 2, Money(149, "USD")), Line("bread", 1, Money(325, "USD"))],
)


def test_shipment_total_counts_only_its_lines():
    assert shipment_total(ORDER, ["bread"]) == Money(325, "USD")
