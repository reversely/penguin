"""Ranking produce that is in season higher in search."""


def in_season(month: int, season: tuple[int, int]) -> bool:
    """Whether ``month`` (1 to 12) falls in a season that may wrap past December."""
    start, end = season
    return start <= month <= end if start <= end else month >= start or month <= end
