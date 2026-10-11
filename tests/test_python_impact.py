"""Checks on the Python impact graph and contract diff (services/local-bridge/analysis/python_impact.py)."""

import ast
import builtins
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ANALYSER = ROOT / "services" / "local-bridge" / "analysis" / "python_impact.py"
EXAMPLES = ROOT / "examples"

_spec = importlib.util.spec_from_file_location("python_impact", ANALYSER)
impact = importlib.util.module_from_spec(_spec)
sys.modules["python_impact"] = impact
_spec.loader.exec_module(impact)

SCOPES = {
    "scopes": [
        {
            "id": "core",
            "name": "Core",
            "owner": "a",
            "paths": ["core/"],
            "test_command": "true",
            "depends_on": [],
        },
        {
            "id": "app",
            "name": "App",
            "owner": "b",
            "paths": ["app/"],
            "test_command": "true",
            "depends_on": [],
        },
        {
            "id": "other",
            "name": "Other",
            "owner": "c",
            "paths": ["other/"],
            "test_command": "true",
            "depends_on": [],
        },
    ]
}


def _git_env() -> dict[str, str]:
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    env.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_AUTHOR_NAME="Test",
        GIT_AUTHOR_EMAIL="test@penguin.invalid",
        GIT_COMMITTER_NAME="Test",
        GIT_COMMITTER_EMAIL="test@penguin.invalid",
    )
    return env


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=_git_env(),
    ).stdout.strip()


class Repo:
    """A throwaway repository; each commit writes files over the previous tree."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.mkdir()
        git(path, "init", "--quiet", "--template=", "-b", "main")

    def commit(
        self, files: dict[str, str | bytes | None], start: str | None = None
    ) -> str:
        if start is not None:
            git(self.path, "checkout", "--quiet", "--detach", start)
        for name, content in files.items():
            target = self.path / name
            if content is None:
                target.unlink()
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content)
        git(self.path, "add", "--all")
        git(
            self.path,
            "commit",
            "--quiet",
            "--no-verify",
            "--allow-empty",
            "-m",
            "change",
        )
        return git(self.path, "rev-parse", "HEAD")


def base_files(**files: str) -> dict[str, str]:
    return {
        "penguin/scopes.json": json.dumps(SCOPES),
        "core/__init__.py": "",
        "app/__init__.py": "",
        **files,
    }


def run(repo: Repo, base: str, head: str, forks=(), limits=None) -> dict:
    request = impact.parse_request({"base": base, "head": head, "forks": list(forks)})
    return impact.analyse(
        impact.GitRepo(str(repo.path)), request, limits or impact.Limits()
    )


def changes(report: dict) -> dict[str, str]:
    return {change["symbol"]: change["change"] for change in report["changes"]}


@pytest.fixture
def repo(tmp_path: Path) -> Repo:
    return Repo(tmp_path / "repo")


# Kinds of change.


def test_a_rename_is_one_change_with_its_new_name(repo: Repo):
    base = repo.commit(
        base_files(**{"core/util.py": "def old(x):\n    return x + 1\n"})
    )
    head = repo.commit({"core/util.py": "def new(x):\n    return x + 1\n"})
    report = run(repo, base, head)
    assert report["changes"] == [
        {
            "symbol": "core.util.old",
            "path": "core/util.py",
            "line": 1,
            "kind": "function",
            "change": "renamed",
            "to": {"symbol": "core.util.new", "path": "core/util.py", "line": 1},
            "scope": "core",
            "contract": None,
        }
    ]
    assert report["removedExports"] == [
        {"module": "core.util", "path": "core/util.py", "name": "old"}
    ]


def test_a_move_names_the_new_module_and_a_kept_re_export_is_not_a_removed_export(
    repo: Repo,
):
    body = "def helper(x):\n    return x * 2\n"
    base = repo.commit(base_files(**{"core/a.py": body, "core/b.py": ""}))
    head = repo.commit({"core/a.py": "from core.b import helper\n", "core/b.py": body})
    report = run(repo, base, head)
    assert changes(report) == {"core.a.helper": "moved"}
    assert report["changes"][0]["to"]["symbol"] == "core.b.helper"
    assert report["removedExports"] == []


def test_an_added_parameter_with_a_default_is_not_breaking_and_one_without_is(
    repo: Repo,
):
    base = repo.commit(base_files(**{"core/f.py": "def f(a, b=1):\n    return a\n"}))
    optional = repo.commit({"core/f.py": "def f(a, b=1, *, c=None):\n    return a\n"})
    required = repo.commit(
        {"core/f.py": "def f(a, d, b=1):\n    return a\n"}, start=base
    )
    soft = run(repo, base, optional)["signatures"][0]
    assert soft["added"] == [{"name": "c", "required": False}]
    assert soft["breaking"] is False
    hard = run(repo, base, required)["signatures"][0]
    assert hard["before"] == "(a, b=1)"
    assert hard["after"] == "(a, d, b=1)"
    assert hard["reasons"] == ["adds required parameter d"]
    assert hard["breaking"] is True


def test_a_removed_parameter_and_a_lost_default_are_breaking(repo: Repo):
    base = repo.commit(
        base_files(**{"core/f.py": "def f(a, b=1, c=2):\n    return a\n"})
    )
    head = repo.commit({"core/f.py": "def f(a, b):\n    return a\n"})
    signature = run(repo, base, head)["signatures"][0]
    assert signature["removed"] == ["c"]
    assert signature["reasons"] == ["removes parameter c", "removes the default of b"]


def test_a_name_dropped_from_all_is_a_removed_export(repo: Repo):
    base = repo.commit(
        base_files(**{"core/api.py": "__all__ = ['one', 'two']\none = 1\ntwo = 2\n"})
    )
    head = repo.commit({"core/api.py": "__all__ = ['one']\none = 1\ntwo = 2\n"})
    assert run(repo, base, head)["removedExports"] == [
        {"module": "core.api", "path": "core/api.py", "name": "two"}
    ]


def test_a_removed_function_is_removed_and_its_callers_are_listed(repo: Repo):
    base = repo.commit(
        base_files(
            **{
                "core/f.py": "def gone():\n    return 1\n\ndef kept():\n    return 2\n",
                "app/use.py": "from core.f import gone, kept\n\nkept()\ngone()\n",
            }
        )
    )
    head = repo.commit({"core/f.py": "def kept():\n    return 2\n"})
    report = run(repo, base, head, [{"id": "fork-app", "sha": base, "scopes": ["app"]}])
    assert changes(report) == {"core.f.gone": "removed"}
    uses = [
        (use["path"], use["line"], use["kind"], use["symbol"])
        for use in report["forks"][0]["uses"]
    ]
    assert uses == [
        ("app/use.py", 1, "import", "core.f.gone"),
        ("app/use.py", 4, "call", "core.f.gone"),
    ]


def test_a_dataclass_field_change_is_a_stored_shape_change(repo: Repo):
    record = "from dataclasses import dataclass\n\n@dataclass\nclass Row:\n    id: str\n    cents: int\n"
    base = repo.commit(base_files(**{"core/rows.py": record}))
    head = repo.commit(
        {
            "core/rows.py": record.replace(
                "cents: int", "amount_minor: int\n    currency: str = 'GBP'"
            )
        }
    )
    shape = run(repo, base, head)["dataShapes"][0]
    assert shape["kind"] == "dataclass"
    assert shape["removed"] == ["cents"]
    assert shape["added"] == ["amount_minor", "currency"]
    assert shape["after"] == ["id: str", "amount_minor: int", "currency: str = 'GBP'"]


def test_a_docstring_edit_changes_nothing(repo: Repo):
    base = repo.commit(
        base_files(**{"core/f.py": 'def f():\n    """Old."""\n    return 1\n'})
    )
    head = repo.commit({"core/f.py": 'def f():\n    """New words."""\n    return 1\n'})
    assert run(repo, base, head)["changes"] == []


def test_a_re_export_that_points_at_a_new_definition_is_modified_with_its_origin(
    repo: Repo,
):
    v1 = "class Thing:\n    def __init__(self, a):\n        self.a = a\n"
    v2 = "class Thing:\n    def __init__(self, a, b=0):\n        self.a = a\n"
    base = repo.commit(
        base_files(
            **{
                "core/v1.py": v1,
                "core/api.py": "from core.v1 import Thing\n__all__ = ['Thing']\n",
            }
        )
    )
    head = repo.commit(
        {
            "core/v2.py": v2,
            "core/api.py": "from core.v2 import Thing\n__all__ = ['Thing']\n",
        }
    )
    report = run(repo, base, head)
    modified = {
        change["symbol"]: change.get("origin")
        for change in report["changes"]
        if change["change"] == "modified"
    }
    assert modified["core.api.Thing"] == {
        "before": "core.v1.Thing",
        "after": "core.v2.Thing",
    }
    assert [signature["symbol"] for signature in report["signatures"]] == [
        "core.api.Thing.__init__"
    ]


def test_a_method_call_through_an_annotated_parameter_is_a_caller(repo: Repo):
    base = repo.commit(
        base_files(
            **{
                "core/store.py": "class Store:\n    def get(self, k):\n        return k\n    def put(self, k):\n        return k\n",
                "app/use.py": (
                    "from core.store import Store\n\n"
                    "def read(store: Store):\n    store.put(1)\n    return store.get(1)\n\n"
                    "def local():\n    s = Store()\n    return s.get(2)\n"
                ),
            }
        )
    )
    head = repo.commit({"core/store.py": base_store_with_new_get()})
    report = run(repo, base, head, [{"id": "f", "sha": base, "scopes": ["app"]}])
    calls = [
        (use["line"], use["symbol"])
        for use in report["forks"][0]["uses"]
        if use["kind"] == "call"
    ]
    assert calls == [
        (5, "core.store.Store.get"),
        (8, "core.store.Store"),
        (9, "core.store.Store.get"),
    ]


def base_store_with_new_get() -> str:
    return "class Store:\n    def get(self, k):\n        return None\n    def put(self, k):\n        return k\n"


# Selection inputs, contracts and coverage.


def test_a_fork_whose_scopes_never_use_the_change_has_no_uses(repo: Repo):
    base = repo.commit(
        base_files(
            **{
                "core/f.py": "def f():\n    return 1\n",
                "app/a.py": "from core.f import f\n",
                "other/o.py": "x = 1\n",
            }
        )
    )
    head = repo.commit({"core/f.py": "def f():\n    return 2\n"})
    report = run(
        repo,
        base,
        head,
        [
            {"id": "fork-app", "sha": base, "scopes": ["app"]},
            {"id": "fork-other", "sha": base, "scopes": ["other"]},
        ],
    )
    assert [len(fork["uses"]) for fork in report["forks"]] == [1, 0]
    assert report["complete"] is True


def test_a_declared_contract_is_named_on_its_change(repo: Repo):
    scopes = json.loads(json.dumps(SCOPES))
    scopes["scopes"][0]["contracts"] = ["core/f.py::Api"]
    base = repo.commit(
        {
            **base_files(
                **{"core/f.py": "class Api:\n    def call(self):\n        return 1\n"}
            ),
            "penguin/scopes.json": json.dumps(scopes),
        }
    )
    head = repo.commit(
        {"core/f.py": "class Api:\n    def call(self):\n        return 2\n"}
    )
    report = run(repo, base, head)
    assert report["contracts"] == ["core/f.py::Api"]
    assert {change["symbol"]: change["contract"] for change in report["changes"]} == {
        "core.f.Api": "core/f.py::Api",
        "core.f.Api.call": "core/f.py::Api",
    }


def test_a_changed_file_the_analysis_cannot_read_makes_the_report_incomplete(
    repo: Repo,
):
    base = repo.commit(base_files(**{"core/data.json": "{}"}))
    head = repo.commit({"core/data.json": '{"a": 1}'})
    report = run(repo, base, head)
    assert report["unanalysed"] == ["core/data.json"]
    assert report["complete"] is False


# Hostile input.


@pytest.mark.parametrize(
    ("content", "kind"),
    [
        ("def f(:\n", "syntax"),
        (b"x = '\xff\xfe'\n", "not-utf8"),
        ("x = " + "[" * 150 + "]" * 150 + "\n", "too-deep"),
        ("x = " + "(" * 5000 + ")" * 5000 + "\n", None),
        ("x = 1\0\n", "syntax"),
    ],
)
def test_unreadable_source_is_a_structured_error(repo: Repo, content, kind):
    base = repo.commit(base_files())
    head = repo.commit({"core/bad.py": content})
    report = run(repo, base, head)
    [error] = report["errors"]
    assert error["path"] == "core/bad.py"
    assert error["tree"] == "head"
    assert error["kind"] in ({kind} if kind else {"syntax", "too-deep"})
    assert report["unanalysed"] == ["core/bad.py"]


def test_an_oversized_file_is_not_read(repo: Repo):
    base = repo.commit(base_files())
    head = repo.commit({"core/big.py": "x = 1\n" * 100})
    report = run(repo, base, head, limits=impact.Limits(max_file_bytes=100))
    assert [(error["kind"], error["path"]) for error in report["errors"]] == [
        ("too-large", "core/big.py")
    ]


def test_analysed_code_is_never_imported_or_run(repo: Repo, tmp_path: Path):
    marker = tmp_path / "ran"
    payload = (
        f"open({str(marker)!r}, 'w').write('ran')\n"
        "import os\nos.system('touch ' + {marker!r})\n"
        "raise SystemExit(3)\n\ndef f():\n    return 1\n"
    ).replace("{marker!r}", repr(str(marker)))
    base = repo.commit(
        base_files(**{"core/boom.py": payload, "core/__init__.py": payload})
    )
    head = repo.commit({"core/boom.py": payload.replace("return 1", "return 2")})
    report = run(repo, base, head)
    assert changes(report) == {"core.boom.f": "modified"}
    assert not marker.exists()


def test_a_symlink_is_never_followed(repo: Repo, tmp_path: Path):
    outside = tmp_path / "outside.py"
    outside.write_text("def secret():\n    return 1\n")
    base = repo.commit(base_files())
    (repo.path / "core" / "link.py").symlink_to(outside)
    head = repo.commit({})
    report = run(repo, base, head)
    assert "core/link.py" not in json.dumps(report["changes"])
    assert report["files"]["head"] == report["files"]["base"]


@pytest.mark.parametrize(
    "path", ["../x.py", "/etc/x.py", "a/../b.py", "a//b.py", "./a.py", "a\\b.py", ""]
)
def test_a_path_outside_the_checkout_is_refused(path: str):
    assert impact.is_safe_path(path) is False


@pytest.mark.parametrize(
    "request_body",
    [
        [],
        {"base": "HEAD", "head": "a" * 40},
        {"base": "a" * 40, "head": "a" * 40, "forks": [{"id": "-rf", "sha": "a" * 40}]},
        {
            "base": "a" * 40,
            "head": "a" * 40,
            "forks": [{"id": "x; rm", "sha": "a" * 40}],
        },
        {
            "base": "a" * 40,
            "head": "a" * 40,
            "forks": [{"id": "x", "sha": "a" * 40, "scopes": [3]}],
        },
    ],
)
def test_a_malformed_request_is_refused(request_body):
    with pytest.raises(impact.RequestError):
        impact.parse_request(request_body)


def test_the_command_line_reports_a_missing_commit_without_a_traceback(repo: Repo):
    repo.commit(base_files())
    result = subprocess.run(
        [sys.executable, "-I", str(ANALYSER), "--repo", str(repo.path)],
        input=json.dumps({"base": "a" * 40, "head": "b" * 40}),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stderr.startswith("python-impact: git ls-tree failed")
    assert "Traceback" not in result.stderr


def test_output_is_deterministic(repo: Repo):
    base = repo.commit(
        base_files(
            **{
                "core/f.py": "def f():\n    return 1\n",
                "app/a.py": "from core.f import f\nf()\n",
            }
        )
    )
    head = repo.commit({"core/f.py": "def f():\n    return 2\n"})
    forks = [
        {"id": "z", "sha": base, "scopes": ["app"]},
        {"id": "a", "sha": base, "scopes": ["app"]},
    ]
    first = json.dumps(run(repo, base, head, forks), sort_keys=True)
    assert first == json.dumps(run(repo, base, head, forks), sort_keys=True)


# The fixtures in examples/.


def build_fixture(name: str, target: Path) -> dict[str, str]:
    subprocess.run(
        [sys.executable, str(EXAMPLES / name / "build.py"), str(target)],
        check=True,
        capture_output=True,
    )
    return json.loads((EXAMPLES / name / "pins.json").read_text())


def scope_ids_of(owner: str, repo: Path) -> list[str]:
    scopes = json.loads((repo / "penguin" / "scopes.json").read_text())["scopes"]
    return [scope["id"] for scope in scopes if scope["owner"] == owner]


def fixture_report(name: str, changer: str, others: list[str], tmp_path: Path) -> dict:
    """Analyse one fixture: the changer's checkpoint against main, with each other owner's checkpoint as a fork."""
    target = tmp_path / name
    pins = build_fixture(name, target)
    forks = [
        {
            "id": f"owner-{owner}",
            "sha": pins["tags"][f"owner-{owner}-checkpoint"],
            "scopes": scope_ids_of(owner, target),
        }
        for owner in others
    ]
    request = impact.parse_request(
        {
            "base": pins["branches"]["main"],
            "head": pins["tags"][f"owner-{changer}-checkpoint"],
            "forks": forks,
        }
    )
    return impact.analyse(impact.GitRepo(str(target)), request)


def callers(report: dict) -> dict[str, set[tuple[str, str]]]:
    return {
        fork["id"]: {(use["path"], use["symbol"]) for use in fork["uses"]}
        for fork in report["forks"]
    }


def test_helpful_fix_lists_the_callers_of_the_changed_day_helper_in_both_forks(
    tmp_path: Path,
):
    report = fixture_report("helpful-fix", "priya", ["jun", "sam"], tmp_path)
    modified = [
        change for change in report["changes"] if change["change"] == "modified"
    ]
    assert [(change["path"], change["kind"]) for change in modified] == [
        ("shared/dates.py", "function")
    ]
    symbol = modified[0]["symbol"]
    assert report["signatures"] == []  # the behaviour changes; the signature does not
    found = callers(report)
    assert found["owner-jun"] == {("analytics/weekly.py", symbol)}
    assert found["owner-sam"] == {("messaging/reminders.py", symbol)}
    kinds = {use["kind"] for fork in report["forks"] for use in fork["uses"]}
    assert kinds == {"import", "call"}
    assert report["complete"] is True


def test_identity_unification_lists_the_importers_of_the_identity_map(tmp_path: Path):
    report = fixture_report("identity-unification", "priya", ["jun", "sam"], tmp_path)
    changed_paths = {
        change["path"] for change in report["changes"] if change["change"] == "modified"
    }
    assert changed_paths == {"ingestion/identity_map.py"}
    assert [shape["kind"] for shape in report["dataShapes"]] == ["dataclass"]
    assert any(signature["breaking"] for signature in report["signatures"])
    for fork in report["forks"]:
        importers = {use["path"] for use in fork["uses"] if use["kind"] == "import"}
        scope_paths = {use["scope"] for use in fork["uses"]}
        assert importers, fork["id"]
        assert scope_paths == set(fork["scopes"])


def test_dependency_bump_lists_payments_as_a_user_of_the_upgraded_client(
    tmp_path: Path,
):
    report = fixture_report("dependency-bump", "hugo", ["ana"], tmp_path)
    retargeted = [change for change in report["changes"] if "origin" in change]
    assert retargeted, "the client's re-export points at the new version"
    [fork] = report["forks"]
    assert fork["scopes"] == ["payments"]
    assert {use["symbol"] for use in fork["uses"]} <= {
        change["symbol"] for change in retargeted
    }
    assert any(
        use["path"] == "payments/webhooks.py" and use["kind"] == "import"
        for use in fork["uses"]
    )


def test_no_fixture_name_appears_in_the_analysis_code():
    names = set()
    for fixture in EXAMPLES.iterdir():
        for path in fixture.rglob("*.py"):
            if path.name == "build.py":
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(
                    node, (ast.FunctionDef, ast.ClassDef)
                ) and not node.name.startswith(("test_", "_")):
                    names.add(node.name)
        for scopes in fixture.rglob("scopes.json"):
            for scope in json.loads(scopes.read_text())["scopes"]:
                names.update({scope["id"], scope["owner"], *scope["paths"]})
    source = ast.parse(ANALYSER.read_text())
    literals = {
        node.value
        for node in ast.walk(source)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    identifiers = {node.id for node in ast.walk(source) if isinstance(node, ast.Name)}
    assert names & literals == set()
    assert names & identifiers <= set(dir(builtins))
