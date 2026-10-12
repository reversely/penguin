"""Backfill of stored shopper records into the per-identity shape.

Before merge rules, a stored shopper record holds ``attributes``: each attribute's latest
``[ts, value]``. A merged shopper keeps attributes per identity, in ``by_identity``. A record of the
old shape had one identity, its key, so each attribute moves under that identity.
"""


def backfill_shopper(record: dict) -> dict:
    """Return ``record`` in the per-identity shape; a record already in it comes back unchanged."""
    if "by_identity" in record:
        return record
    return {
        "key": record["key"],
        "identities": sorted(record.get("identities", [record["key"]])),
        "by_identity": {
            record["key"]: {
                name: list(entry) for name, entry in record["attributes"].items()
            }
        },
    }
