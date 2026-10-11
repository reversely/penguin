"""Cursor pagination for any list the apps page through."""


def page(items: list, cursor: int, limit: int) -> tuple[list, int | None]:
    """The items from ``cursor`` on, at most ``limit`` of them, and the next page's cursor or None."""
    end = cursor + limit
    return items[cursor:end], (end if end < len(items) else None)
