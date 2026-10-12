"""Stock a store can still sell."""


def available(on_hand: int, reserved: int) -> int:
    """Units free to sell: on hand less those reserved for open orders, never below zero."""
    return max(on_hand - reserved, 0)
