"""An in-process stand-in for the flag service, used as the HTTP client's transport."""

from shared.platform.http import Request, Response, Timeout


class FakeFlagService:
    """Answer each rollout request from ``percents``; drop the first ``dropped`` requests."""

    def __init__(self, percents: dict[str, int], dropped: int = 0) -> None:
        self.percents = percents
        self.dropped = dropped

    def __call__(self, request: Request) -> Response:
        if self.dropped:
            self.dropped -= 1
            raise Timeout(request.url)
        return Response(200, {"percent": self.percents[request.json["flag"]]})
