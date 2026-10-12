"""Rolling a feature out to a share of stores."""

import zlib


def enabled(flag: str, store_id: str, percent: int) -> bool:
    """Whether a flag is on for a store: a stable share of stores, ``percent`` out of 100."""
    return zlib.crc32(f"{flag}:{store_id}".encode()) % 100 < percent
