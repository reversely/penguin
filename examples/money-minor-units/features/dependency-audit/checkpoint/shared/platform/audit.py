"""Which pinned dependencies are behind their latest release."""


def outdated(pinned: dict[str, str], latest: dict[str, str]) -> list[str]:
    """The packages whose pinned version differs from the latest one, in order."""
    return sorted(
        name for name, version in pinned.items() if latest.get(name, version) != version
    )
