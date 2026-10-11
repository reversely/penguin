"""Checks on the dependency diff (services/local-bridge/analysis/python_dependencies.py)."""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANALYSER = ROOT / "services" / "local-bridge" / "analysis" / "python_dependencies.py"

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


def commit(repo: Path, files: dict[str, str]) -> str:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    git(repo, "add", "--all")
    git(repo, "commit", "--quiet", "-m", "commit")
    return git(repo, "rev-parse", "HEAD")


def analyse(repo: Path, request: dict) -> tuple[int, dict | str]:
    result = subprocess.run(
        [sys.executable, "-I", str(ANALYSER), "--repo", str(repo)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return result.returncode, result.stderr
    return 0, json.loads(result.stdout)


def test_each_manifest_kind_and_vendored_code_report_their_version_changes(tmp_path):
    repo = tmp_path / "repo"
    git(tmp_path, "init", "--quiet", "-b", "main", str(repo))
    base = commit(
        repo,
        {
            "penguin/scopes.json": json.dumps(SCOPES),
            "pyproject.toml": '[project]\nname = "x"\ndependencies = ["Requests>=2.31", "attrs"]\n'
            '[dependency-groups]\ndev = ["pytest==9.0"]\n',
            "requirements-dev.txt": "# tools\nblack==24.1  # pinned\n-r other.txt\n",
            "uv.lock": 'version = 1\n[[package]]\nname = "requests"\nversion = "2.31.0"\n',
            "core/__init__.py": "",
            "core/vendor_v1.py": '__version__ = "1.0.0"\n',
            "core/client.py": "from core.vendor_v1 import __version__\n",
            "app/__init__.py": "",
            "app/use.py": "import requests\nfrom core import client\n",
            "app/other.py": "import attrs\n",
        },
    )
    head = commit(
        repo,
        {
            "pyproject.toml": '[project]\nname = "x"\ndependencies = ["requests>=2.32", "attrs"]\n'
            '[dependency-groups]\ndev = ["pytest==9.0"]\n',
            "requirements-dev.txt": "black==25.1\n",
            "uv.lock": 'version = 1\n[[package]]\nname = "requests"\nversion = "2.32.3"\n',
            "core/vendor_v2.py": '__version__ = "2.0.0"\n',
            "core/client.py": "from core.vendor_v2 import __version__\n",
        },
    )
    code, report = analyse(
        repo,
        {
            "base": base,
            "head": head,
            "forks": [{"id": "b", "sha": head, "scopes": ["app"]}],
        },
    )
    assert code == 0, report
    changes = {
        (change["source"], change["library"]): (change["before"], change["after"])
        for change in report["changes"]
    }
    assert changes == {
        ("pyproject.toml", "requests"): (">=2.31", ">=2.32"),
        ("requirements", "black"): ("==24.1", "==25.1"),
        ("uv.lock", "requests"): ("2.31.0", "2.32.3"),
        ("vendored", "core.client"): ("1.0.0", "2.0.0"),
    }
    vendored = next(c for c in report["changes"] if c["source"] == "vendored")
    assert vendored["origin"] == {"before": "core.vendor_v1", "after": "core.vendor_v2"}
    uses = [
        (use["path"], use["line"], use["library"]) for use in report["forks"][0]["uses"]
    ]
    assert uses == [
        ("app/use.py", 1, "requests"),
        ("app/use.py", 2, "core.client"),
    ]


def test_a_malformed_request_or_missing_commit_exits_2(tmp_path):
    repo = tmp_path / "repo"
    git(tmp_path, "init", "--quiet", "-b", "main", str(repo))
    code, message = analyse(repo, {"base": "HEAD", "head": "0" * 40})
    assert code == 2 and "base must be a full lowercase commit SHA" in message
    code, message = analyse(repo, {"base": "0" * 40, "head": "0" * 40})
    assert code == 2 and "git ls-tree failed" in message
