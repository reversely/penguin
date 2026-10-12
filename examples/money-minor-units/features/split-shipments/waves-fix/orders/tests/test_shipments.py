from orders.model import Line, Order
from orders.shipments import shipment_total
from shared.money import Money

ORDER = Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)])


def test_shipment_total_counts_only_its_lines():
    """A shipment's total counts only the lines in that shipment."""
    assert shipment_total(ORDER, ["bread"]) == Money(325, "USD")
