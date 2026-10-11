from invoicing.business import statement_total
from orders.model import Line, Order

ORDERS = [
    Order("o-1", "NY", "USD", [Line("milk", 2, 1.49), Line("bread", 1, 3.25)]),
    Order("o-2", "NJ", "USD", [Line("coffee", 1, 10.0)]),
]


def test_statement_sums_every_invoice():
    assert statement_total(ORDERS) == 17.44
