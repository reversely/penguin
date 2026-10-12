"""Rows sent to the CRM: one per shopper that has an email address."""

from accounts.shoppers import ShopperMap
from messaging.subscriptions import is_subscribed


def crm_rows(shopper_map: ShopperMap) -> list[dict[str, object]]:
    return [
        {
            "shopper": shopper.key,
            "email": shopper.get("email"),
            "subscribed": is_subscribed(shopper),
        }
        for shopper in shopper_map.shoppers()
        if shopper.get("email")
    ]
