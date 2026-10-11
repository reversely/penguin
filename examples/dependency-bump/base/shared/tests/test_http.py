import pytest

from shared.http import Client, Request, Response, Timeout


def test_post_sends_the_body_and_headers_to_the_full_url():
    sent = []

    def transport(request: Request) -> Response:
        sent.append(request)
        return Response(200, {"ok": True})

    client = Client("https://api.example.invalid/", transport)
    response = client.post("/v1/things", {"a": 1}, {"X-Trace": "t1"})
    assert response == Response(200, {"ok": True})
    assert sent == [
        Request(
            "POST", "https://api.example.invalid/v1/things", {"a": 1}, {"X-Trace": "t1"}
        )
    ]


def test_timeout_reaches_the_caller_when_no_response_arrives():
    def transport(request: Request) -> Response:
        raise Timeout(request.url)

    with pytest.raises(Timeout):
        Client("https://api.example.invalid", transport).post("/v1/things", {})
