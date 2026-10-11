"""An in-process stand-in for the carrier's rates API, used as a client transport."""

from shared.http import Request, Response, Timeout


class FakeCarrier:
    """Answer each rate request with 5 cents per 100 grams plus 300 cents.

    The first ``dropped`` requests time out before the carrier answers them, as the carrier's API
    does after a period without traffic.
    """

    def __init__(self, dropped: int = 0) -> None:
        self.dropped = dropped
        self.requests: list[Request] = []

    def __call__(self, request: Request) -> Response:
        self.requests.append(request)
        if self.dropped:
            self.dropped -= 1
            raise Timeout(request.url)
        return Response(200, {"amount_cents": 300 + request.json["weight_grams"] // 20})
