"""An in-process stand-in for the payment processor's charges API, used as a client transport."""

from shared.http import Request, Response, Timeout

DECLINED_CUSTOMERS = frozenset({"cus_declined"})


class FakeProcessor:
    """Record each charge it makes, as a real processor's ledger does.

    A request with an ``Idempotency-Key`` header that the processor has already seen gets the first
    request's response again and makes no new charge. The first ``lost_responses`` responses are
    lost after the charge is made: the caller sees a timeout although the card was charged.
    """

    def __init__(self, lost_responses: int = 0) -> None:
        self.lost_responses = lost_responses
        self.charges: list[dict] = []
        self.responses_by_key: dict[str, Response] = {}

    def __call__(self, request: Request) -> Response:
        key = request.headers.get("Idempotency-Key")
        if key in self.responses_by_key:
            response = self.responses_by_key[key]
        else:
            response = self.charge(request.json)
            if key is not None:
                self.responses_by_key[key] = response
        if self.lost_responses:
            self.lost_responses -= 1
            raise Timeout(request.url)
        return response

    def charge(self, body: dict) -> Response:
        if body["customer_id"] in DECLINED_CUSTOMERS:
            return Response(402, {"error": "card_declined"})
        charge = {"id": f"ch_{len(self.charges) + 1}", **body}
        self.charges.append(charge)
        return Response(200, {"charge_id": charge["id"]})

    def charges_for(self, order_id: str) -> list[dict]:
        return [charge for charge in self.charges if charge["order_id"] == order_id]
