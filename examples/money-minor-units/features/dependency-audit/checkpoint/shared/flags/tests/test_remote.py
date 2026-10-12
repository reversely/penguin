from shared.flags.remote import fetch_rollout
from shared.flags.tests.fake_flag_service import FakeFlagService
from shared.platform.http import Client

FLAGS_URL = "https://flags.example.invalid"


def test_fetch_reads_the_rollout_percent():
    client = Client(FLAGS_URL, FakeFlagService({"new-checkout": 25}))
    assert fetch_rollout(client, "new-checkout") == 25


def test_an_unanswered_fetch_reads_as_no_rollout():
    client = Client(FLAGS_URL, FakeFlagService({"new-checkout": 25}, dropped=3))
    assert fetch_rollout(client, "new-checkout") is None


def test_rollout_survives_one_dropped_request():
    """A flag's rollout is read when the flag service drops one request."""
    client = Client(FLAGS_URL, FakeFlagService({"new-checkout": 25}, dropped=1))
    assert fetch_rollout(client, "new-checkout") == 25
