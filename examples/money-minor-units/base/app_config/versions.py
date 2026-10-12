"""Which app versions the API still serves."""


def parse(version: str) -> tuple[int, ...]:
    """A dotted version as numbers, such as ``(4, 12, 0)``."""
    return tuple(int(part) for part in version.split("."))


def is_supported(version: str, minimum: str) -> bool:
    """Whether an app at ``version`` may still call the API."""
    return parse(version) >= parse(minimum)
