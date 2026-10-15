"""The deterministic tools behind Penguin's checks (PRD 0.5 section 5), each run as the runner runs it.

Each test builds a small real git repository, runs one tool on it and checks one thing that tool
must find: who calls a changed contract, what a codemod rewrites, which library changed version and
what a function returns on given inputs.
"""

import json
import subprocess
import sys
from pathlib import Path

ANALYSIS = (
    Path(__file__).resolve().parents[1] / "services" / "local-bridge" / "analysis"
)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo: Path, files: dict[str, str], message: str) -> str:
    for path, text in files.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message)
    return git(repo, "rev-parse", "HEAD")


def new_repo(tmp_path: Path, files: dict[str, str]) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    return repo, commit(repo, files, "base")


def run(tool: str, flag: str, path: Path, request: dict) -> dict:
    result = subprocess.run(
        [sys.executable, "-I", str(ANALYSIS / tool), flag, str(path)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


SCOPES = {
    "scopes": [
        {
            "id": "dates",
            "name": "Dates",
            "owner": "priya",
            "paths": ["shared/"],
            "contracts": ["shared/dates.py::start_of_day"],
            "test_command": "true",
            "depends_on": [],
        },
        {
            "id": "analytics",
            "name": "Analytics",
            "owner": "jun",
            "paths": ["analytics/"],
            "contracts": [],
            "test_command": "true",
            "depends_on": [{"scope": "dates", "kind": "imports"}],
        },
    ]
}
BASE = {
    "penguin/scopes.json": json.dumps(SCOPES),
    "shared/__init__.py": "",
    "shared/dates.py": "def start_of_day(day):\n    return day\n",
    "analytics/__init__.py": "",
    "analytics/weekly.py": "from shared.dates import start_of_day\n\n\ndef week(day):\n    return start_of_day(day)\n",
}


def test_impact_finds_a_rename_and_the_caller_in_another_scope(tmp_path: Path) -> None:
    repo, base = new_repo(tmp_path, BASE)
    head = commit(
        repo,
        {"shared/dates.py": "def start_of_local_day(day):\n    return day\n"},
        "rename",
    )
    report = run(
        "python_impact.py", "--repo", repo, {"base": base, "head": head, "forks": []}
    )
    changed = {change["symbol"]: change["change"] for change in report["changes"]}
    assert changed.get("shared.dates.start_of_day") in {"renamed", "removed"}
    assert any(
        use["path"] == "analytics/weekly.py" and use["scope"] == "analytics"
        for use in report["headUses"]
    )


def test_impact_reports_a_new_required_parameter_as_breaking(tmp_path: Path) -> None:
    repo, base = new_repo(tmp_path, BASE)
    head = commit(
        repo,
        {"shared/dates.py": "def start_of_day(day, offset):\n    return day\n"},
        "offset",
    )
    report = run(
        "python_impact.py", "--repo", repo, {"base": base, "head": head, "forks": []}
    )
    signature = next(
        each
        for each in report["signatures"]
        if each["symbol"] == "shared.dates.start_of_day"
    )
    assert signature["breaking"] is True


def test_impact_counts_only_a_forks_own_changes_as_its_callers(tmp_path: Path) -> None:
    repo, base = new_repo(tmp_path, BASE)
    git(repo, "checkout", "-qb", "feature")
    fork = commit(
        repo,
        {
            "analytics/monthly.py": "from shared.dates import start_of_day\n\n\ndef month(day):\n    return start_of_day(day)\n"
        },
        "own caller",
    )
    git(repo, "checkout", "-q", "main")
    head = commit(
        repo,
        {"shared/dates.py": "def start_of_day(day, offset):\n    return day\n"},
        "offset",
    )
    report = run(
        "python_impact.py",
        "--repo",
        repo,
        {
            "base": base,
            "head": head,
            "forks": [
                {"id": "monthly", "sha": fork, "scopes": ["analytics"], "since": base}
            ],
        },
    )
    uses = report["forks"][0]["uses"]
    assert {use["path"] for use in uses} == {"analytics/monthly.py"}, (
        "the carried analytics/weekly.py belongs to main"
    )


def test_calls_list_the_names_a_forks_own_changes_use(tmp_path: Path) -> None:
    """#195: a checkpoint's caller list names what its own files use, never what main's files use."""
    repo, base = new_repo(tmp_path, BASE)
    git(repo, "checkout", "-qb", "feature")
    fork = commit(
        repo,
        {
            "analytics/monthly.py": "from shared.dates import start_of_day\n\n\ndef month(day):\n    return start_of_day(day)\n"
        },
        "own caller",
    )
    without = commit(
        repo, {"analytics/monthly.py": "def month(day):\n    return day\n"}, "no caller"
    )
    request = {"base": base, "head": base, "calls": True}
    calls = run(
        "python_impact.py",
        "--repo",
        repo,
        request
        | {"forks": [{"id": "monthly", "sha": fork, "scopes": [], "since": base}]},
    )["forks"][0]["calls"]
    assert calls == ["shared.dates.start_of_day"]
    after = run(
        "python_impact.py",
        "--repo",
        repo,
        request
        | {"forks": [{"id": "monthly", "sha": without, "scopes": [], "since": base}]},
    )["forks"][0]["calls"]
    assert after == [], (
        "the carried analytics/weekly.py is main's caller, not the fork's"
    )


def test_codemod_rewrites_every_call_of_a_renamed_function(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    for path, text in BASE.items():
        (tree / path).parent.mkdir(parents=True, exist_ok=True)
        (tree / path).write_text(text)
    report = run(
        "python_codemod.py",
        "--tree",
        tree,
        {
            "edits": [
                {
                    "kind": "rename",
                    "from": "shared.dates.start_of_day",
                    "to": "shared.dates.start_of_local_day",
                }
            ],
            "paths": ["analytics/weekly.py"],
        },
    )
    text = (tree / "analytics" / "weekly.py").read_text()
    assert "start_of_local_day" in text and "start_of_day(" not in text.replace(
        "start_of_local_day(", ""
    ), report


def test_codemod_expand_keeps_the_old_name_working_beside_the_new(
    tmp_path: Path,
) -> None:
    tree = tmp_path / "tree"
    (tree / "shared").mkdir(parents=True)
    (tree / "shared" / "__init__.py").write_text("")
    (tree / "shared" / "dates.py").write_text(
        "def start_of_local_day(day):\n    return day\n"
    )
    run(
        "python_codemod.py",
        "--tree",
        tree,
        {
            "expand": [
                {
                    "kind": "rename",
                    "from": "shared.dates.start_of_day",
                    "to": "shared.dates.start_of_local_day",
                }
            ],
            "paths": ["shared/dates.py"],
        },
    )
    assert (
        "start_of_day = start_of_local_day"
        in (tree / "shared" / "dates.py").read_text()
    )


def test_a_rule_rewrites_a_method_call_only_on_a_parameter_of_the_contract_class(
    tmp_path: Path,
) -> None:
    tree = tmp_path / "tree"
    (tree / "payouts").mkdir(parents=True)
    caller = (
        "from shared.http import Client\n\n\n"
        "def pay(client: Client, body):\n"
        '    return client.post("/v1/payouts", body)\n\n\n'
        "def other(client, body):\n"
        '    return client.post("/v1/payouts", body)\n'
    )
    (tree / "payouts" / "send.py").write_text(caller)
    report = run(
        "python_codemod.py",
        "--tree",
        tree,
        {
            "rules": [
                {
                    "id": "payout-once",
                    "contract": "shared/http.py::Client",
                    "kind": "expression",
                    "pattern": 'Client.post($client, "/v1/payouts", $body)',
                    "replacement": 'http.post_once($client, "/v1/payouts", $body)',
                    "imports": [],
                }
            ],
            "contracts": {
                "shared/http.py": "class Client:\n    def post(self, path, body):\n        pass\n\n\n"
                "def post_once(client, path, body):\n    pass\n"
            },
            "paths": ["payouts/send.py"],
        },
    )
    text = (tree / "payouts" / "send.py").read_text()
    assert report["refused"] == [], report
    assert 'return post_once(client, "/v1/payouts", body)' in text
    assert text.count('client.post("/v1/payouts", body)') == 1


def test_dependency_diff_names_the_bumped_library_and_who_imports_it(
    tmp_path: Path,
) -> None:
    files = {
        **BASE,
        "pyproject.toml": '[project]\nname = "x"\nversion = "0"\ndependencies = ["httpx>=0.26"]\n',
        "analytics/client.py": "import httpx\n",
    }
    repo, base = new_repo(tmp_path, files)
    head = commit(
        repo,
        {
            "pyproject.toml": '[project]\nname = "x"\nversion = "0"\ndependencies = ["httpx>=0.28"]\n'
        },
        "bump",
    )
    fork = git(repo, "rev-parse", "HEAD")
    report = run(
        "python_dependencies.py",
        "--repo",
        repo,
        {
            "base": base,
            "head": head,
            "forks": [{"id": "analytics", "sha": fork, "scopes": ["analytics"]}],
        },
    )
    text = json.dumps(report)
    assert "httpx" in text and "analytics/client.py" in text


def test_side_by_side_runs_a_contract_on_given_inputs_and_rejects_a_call_that_does_not_fit(
    tmp_path: Path,
) -> None:
    tree = tmp_path / "tree"
    (tree / "shared").mkdir(parents=True)
    (tree / "shared" / "__init__.py").write_text("")
    (tree / "shared" / "money.py").write_text(
        "def cents(amount: float) -> int:\n    return round(amount * 100)\n"
    )
    report = run(
        "side_by_side.py",
        "--tree",
        tree,
        {
            "contracts": ["shared/money.py::cents"],
            "calls": [
                {
                    "id": "ok",
                    "contract": "shared/money.py::cents",
                    "args": {"amount": 1.49},
                },
                {
                    "id": "bad",
                    "contract": "shared/money.py::cents",
                    "args": {"price": 1},
                },
            ],
        },
    )
    results = {each["id"]: each for each in report["results"]}
    assert (results["ok"]["status"], results["ok"]["value"]) == ("returned", 149)
    assert results["bad"]["status"] == "invalid"


REPLAY_TREE = {
    "pytest.ini": "[pytest]\naddopts = -p no:cacheprovider\n",
    "wire.py": (
        "import threading\n"
        "from dataclasses import dataclass, field\n\n\n"
        "@dataclass(frozen=True)\n"
        "class Request:\n"
        "    method: str\n"
        "    url: str\n"
        "    json: dict\n"
        "    headers: dict = field(default_factory=dict)\n\n\n"
        "class Client:\n"
        "    def __init__(self, transport):\n"
        "        self.transport = transport\n"
        "        self.lock = threading.Lock()\n\n"
        "    def post(self, path, json):\n"
        "        return self.transport(Request('POST', 'https://pay.invalid' + path, json))\n"
    ),
    "app/__init__.py": "",
    "app/pay.py": (
        "def pay(client, reference, lines=()):\n"
        "    return client.post('/v1/payouts', {'reference': reference, 'lines': list(lines)})\n"
    ),
    "app/tests/__init__.py": "",
    "app/tests/test_pay.py": (
        "from app.pay import pay\n"
        "from wire import Client\n\n\n"
        "class Ledger:\n"
        "    def __init__(self, path):\n"
        "        self.path = path\n\n"
        "    def __call__(self, request):\n"
        "        with open(self.path, 'a') as ledger:\n"
        "            ledger.write(request.json['reference'] + '\\n')\n"
        "        if request.json['reference'] == 'boom':\n"
        "            raise KeyError('boom')\n"
        "        return 200\n\n\n"
        "def test_pays(tmp_path):\n"
        "    assert pay(Client(Ledger(tmp_path / 'ledger')), 'po-1', range(2000)) == 200\n\n\n"
        "def test_fails(tmp_path):\n"
        "    assert pay(Client(Ledger(tmp_path / 'ledger')), 'po-2') == 201\n\n\n"
        "def test_dies(tmp_path):\n"
        "    pay(Client(Ledger(tmp_path / 'ledger')), 'boom')\n"
    ),
}


def test_caller_replay_plugin_records_calls_results_and_effects_as_data(
    tmp_path: Path,
) -> None:
    tree = tmp_path / "tree"
    for path, text in REPLAY_TREE.items():
        (tree / path).parent.mkdir(parents=True, exist_ok=True)
        (tree / path).write_text(text)
    spec, out = tmp_path / "spec.json", tmp_path / "recording.json"
    symbols = [
        {"symbol": "wire.Client.post", "module": "wire", "qualname": "Client.post"},
        {"symbol": "wire.gone", "module": "wire", "qualname": "gone"},
    ]
    spec.write_text(json.dumps({"version": 1, "symbols": symbols}))
    env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONPATH": str(ANALYSIS / "replay"),
        "PYTEST_ADDOPTS": "-p penguin_caller_replay",
        "PENGUIN_CALLER_REPLAY_SPEC": str(spec),
        "PENGUIN_CALLER_REPLAY_OUT": str(out),
    }
    ran = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "app"],
        # Two of the three tests fail on purpose; the recording is what the test reads.
        check=False,
        cwd=tree,
        env=env,
        capture_output=True,
        text=True,
    )
    assert "1 passed" in ran.stdout and "2 failed" in ran.stdout, ran.stdout
    recording = json.loads(out.read_text())
    assert [(s["symbol"], s["status"]) for s in recording["symbols"]] == [
        ("wire.Client.post", "wrapped"),
        ("wire.gone", "unresolved"),
    ]
    tests = recording["tests"]
    assert tests["app/tests/test_pay.py::test_pays"] == "passed"
    assert tests["app/tests/test_pay.py::test_fails"] == "failed"
    assert tests["app/tests/test_pay.py::test_dies"] == "error"
    calls = {call["test"].split("::")[1]: call for call in recording["calls"]}
    paid = calls["test_pays"]
    # The caller is the feature's line; the request handed to the transport and the file it
    # wrote are the call's effects.
    assert paid["frames"][0] == {"path": "app/pay.py", "line": 2, "function": "pay"}
    assert paid["outcome"] == {"status": "returned", "value": 200}
    kinds = [effect["kind"] for effect in paid["effects"]]
    assert kinds == ["request", "file", "file-content"], kinds
    assert paid["effects"][0]["detail"]["url"] == "https://pay.invalid/v1/payouts"
    assert paid["effects"][1]["detail"]["path"] == "$outside/ledger"
    # A long argument is kept as its digest; a lock has no fields, so it is its repr, marked
    # approximate, with its address removed.
    assert paid["args"]["$truncated"] is True and len(paid["args"]["sha256"]) == 64
    assert calls["test_fails"]["approximate"] is True
    assert "0x?" in json.dumps(calls["test_fails"]["args"])
    assert calls["test_dies"]["outcome"]["status"] == "raised"
    assert calls["test_dies"]["outcome"]["error"]["type"] == "KeyError"
