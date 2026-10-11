"""Checks on the helpful-fix fixture builder (examples/helpful-fix/build.py)."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

BUILDER = Path(__file__).resolve().parents[1] / "examples" / "helpful-fix" / "build.py"


def run_builder(target: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUILDER), str(target)],
        check=False,
        capture_output=True,
        text=True,
    )


def refs(repo: Path) -> dict[str, str]:
    output = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return dict(line.split() for line in output.splitlines())


@pytest.fixture(scope="module")
def built_repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    target = tmp_path_factory.mktemp("fixture") / "repo"
    result = run_builder(target)
    assert result.returncode == 0, result.stderr
    return target


@pytest.fixture(scope="module")
def scopes(built_repo: Path) -> list[dict]:
    return json.loads((built_repo / "penguin" / "scopes.json").read_text())["scopes"]


def test_two_builds_produce_the_same_refs(built_repo: Path, tmp_path: Path):
    second = tmp_path / "second"
    second.mkdir()  # an existing empty directory is accepted as well as a missing one
    assert run_builder(second).returncode == 0
    assert refs(second) == refs(built_repo)


def test_build_reproduces_the_pinned_shas(built_repo: Path):
    pins = json.loads((BUILDER.parent / "pins.json").read_text())
    assert refs(built_repo) == {**pins["branches"], **pins["tags"]}


def test_scopes_are_owned_by_priya_jun_and_sam(scopes: list[dict]):
    assert {scope["id"]: scope["owner"] for scope in scopes} == {
        "ingestion": "priya",
        "analytics": "jun",
        "messaging": "sam",
    }


def test_analytics_and_messaging_depend_on_the_shared_date_helpers(
    scopes: list[dict],
):
    providers = {
        scope["id"]: [dep["scope"] for dep in scope["depends_on"]] for scope in scopes
    }
    assert providers == {
        "ingestion": [],
        "analytics": ["ingestion"],
        "messaging": ["ingestion"],
    }


def test_owners_and_identities_files_list_the_three_owners(built_repo: Path):
    owners = json.loads((built_repo / "penguin" / "owners.json").read_text())["owners"]
    identities = json.loads((built_repo / "penguin" / "identities.json").read_text())
    assert [owner["id"] for owner in owners] == ["priya", "jun", "sam"]
    assert {
        i["handle"]: (i["owner"], i["vendor"]) for i in identities["identities"]
    } == {
        "@priya/batches": ("priya", "claude-code"),
        "@jun/reports": ("jun", "codex"),
        "@sam/reminders": ("sam", "claude-code"),
    }


@pytest.mark.parametrize("scope_id", ["ingestion", "analytics", "messaging"])
def test_scope_test_command_passes_in_the_built_repo(
    built_repo: Path, scopes: list[dict], scope_id: str
):
    # `uv run` puts the project environment first on PATH, so `python` has pytest.
    (command,) = [scope["test_command"] for scope in scopes if scope["id"] == scope_id]
    result = subprocess.run(
        command, check=False, shell=True, cwd=built_repo, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
    status = subprocess.run(
        ["git", "-C", str(built_repo), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout == ""


def test_builder_refuses_a_non_empty_target(tmp_path: Path):
    target = tmp_path / "repo"
    target.mkdir()
    (target / "keep.txt").write_text("existing\n")
    result = run_builder(target)
    assert result.returncode != 0
    assert "not empty" in result.stderr
    assert [p.name for p in target.iterdir()] == ["keep.txt"]


def test_builder_writes_only_inside_the_target(tmp_path: Path):
    target = tmp_path / "repo"
    assert run_builder(target).returncode == 0
    assert [p.name for p in tmp_path.iterdir()] == ["repo"]
