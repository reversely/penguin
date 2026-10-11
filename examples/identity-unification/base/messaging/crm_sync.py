"""Rows sent to the CRM: one per profile that has an email address."""

from ingestion.identity_map import IdentityMap
from messaging.subscriptions import is_subscribed


def crm_rows(identity_map: IdentityMap) -> list[dict[str, object]]:
    return [
        {
            "profile": profile.key,
            "email": profile.get("email"),
            "subscribed": is_subscribed(profile),
        }
        for profile in identity_map.profiles()
        if profile.get("email")
    ]
