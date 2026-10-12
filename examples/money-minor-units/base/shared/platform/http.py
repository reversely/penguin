"""The HTTP client every scope uses, owned by the platform scope.

Every scope imports the client from this module, never from ``vendor/`` directly, so the import
below picks the client version for the whole repository.
"""

from vendor.wire_v1 import Client, Request, Response, Timeout, __version__

__all__ = ["Client", "Request", "Response", "Timeout", "__version__"]
