"""An in-process stand-in for the payment processor, used as the HTTP client's transport in tests.

Checkout charges shoppers and payouts pay stores through the same processor. Each request body
names a ``reference``: the order or payout the money moves for.
"""

from shared.platform.http import Request, Response, Timeout

DECLINED = frozenset({"cus_declined"})


class FakeProcessor:
    """Record each money movement it makes, as a real processor's ledger does.

    A request with an ``Idempotency-Key`` header that the processor has already seen gets the first
    request's response again and moves no money. The first ``lost_responses`` responses are lost
    after the money moves: the caller sees a timeout although the processor acted.
    """

    def __init__(self, lost_responses: int = 0) -> None:
        self.lost_responses = lost_responses
        self.movements: list[dict] = []
        self.responses_by_key: dict[str, Response] = {}

    def __call__(self, request: Request) -> Response:
        key = request.headers.get("Idempotency-Key")
        if key in self.responses_by_key:
            response = self.responses_by_key[key]
        else:
            response = self.move(request.json)
            if key is not None:
                self.responses_by_key[key] = response
        if self.lost_responses:
            self.lost_responses -= 1
            raise Timeout(request.url)
        return response

    def move(self, body: dict) -> Response:
        if body.get("customer_id") in DECLINED:
            return Response(402, {"error": "card_declined"})
        movement = {"id": f"mv_{len(self.movements) + 1}", **body}
        self.movements.append(movement)
        return Response(200, {"id": movement["id"]})

    def movements_for(self, reference: str) -> list[dict]:
        return [m for m in self.movements if m["reference"] == reference]
