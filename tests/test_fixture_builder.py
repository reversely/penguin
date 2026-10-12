"""Checks on the identity-unification fixture builder (examples/identity-unification/build.py)."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BUILDER = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "identity-unification"
    / "build.py"
)


def run_builder(target: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUILDER), str(target)],
        check=False,
        capture_output=True,
        text=True,
    )


def main_sha(repo: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "main"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


@pytest.fixture(scope="module")
def built_repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    target = tmp_path_factory.mktemp("fixture") / "repo"
    result = run_builder(target)
    assert result.returncode == 0, result.stderr
    return target


@pytest.fixture(scope="module")
def scopes(built_repo: Path) -> list[dict]:
    return json.loads((built_repo / "penguin" / "scopes.json").read_text())["scopes"]


def test_two_builds_produce_the_same_refs(tmp_path: Path):
    first, second = tmp_path / "first", tmp_path / "second"
    second.mkdir()  # an existing empty directory is accepted as well as a missing one
    first_build, second_build = run_builder(first), run_builder(second)
    assert first_build.returncode == 0
    assert second_build.returncode == 0
    # The builder prints every branch and tag with its SHA.
    assert first_build.stdout == second_build.stdout
    assert main_sha(first) == main_sha(second)


def test_build_reproduces_the_pinned_shas(built_repo: Path):
    pins = json.loads((BUILDER.parent / "pins.json").read_text())
    refs = subprocess.run(
        [
            "git",
            "-C",
            str(built_repo),
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert dict(line.split() for line in refs.splitlines()) == {
        **pins["branches"],
        **pins["tags"],
    }


def test_each_scope_names_its_team_dri_and_fallback(scopes: list[dict]):
    assert {
        scope["id"]: (scope["team"], scope["dri"], scope["fallback"])
        for scope in scopes
    } == {
        "identity-map": ("data", "priya", ["jun"]),
        "analytics": ("data", "jun", ["priya"]),
        "messaging": ("lifecycle", "sam", []),
    }


def test_teams_file_lists_two_teams_with_their_leads(built_repo: Path):
    teams = json.loads((built_repo / "penguin" / "teams.json").read_text())["teams"]
    assert [(t["id"], t["lead"], t["members"]) for t in teams] == [
        ("data", "priya", ["priya", "jun"]),
        ("lifecycle", "sam", ["sam"]),
    ]


def test_analytics_and_messaging_depend_on_the_identity_map(scopes: list[dict]):
    providers = {
        scope["id"]: [dep["scope"] for dep in scope["depends_on"]] for scope in scopes
    }
    assert providers["analytics"] == ["identity-map"]
    assert providers["messaging"] == ["identity-map"]


def test_owners_and_identities_files_list_the_three_owners(built_repo: Path):
    owners = json.loads((built_repo / "penguin" / "owners.json").read_text())["owners"]
    identities = json.loads((built_repo / "penguin" / "identities.json").read_text())
    assert [owner["id"] for owner in owners] == ["priya", "jun", "sam"]
    assert {
        i["handle"]: (i["owner"], i["vendor"]) for i in identities["identities"]
    } == {
        "@priya/steward": ("priya", "claude-code"),
        "@jun/steward": ("jun", "codex"),
        "@sam/steward": ("sam", "claude-code"),
        "@priya/person-id-merge-rules": ("priya", "claude-code"),
        "@jun/retention-dashboard": ("jun", "codex"),
        "@sam/reengagement-audience": ("sam", "claude-code"),
    }


@pytest.mark.parametrize("scope_id", ["identity-map", "analytics", "messaging"])
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


def test_features_file_names_each_pinned_branch_and_tag():
    features = json.loads((BUILDER.parent / "features.json").read_text())
    pins = json.loads((BUILDER.parent / "pins.json").read_text())
    forks = [feature["fork"] for feature in features["features"]]
    tags = [
        commit["tag"]
        for feature in features["features"]
        for commit in feature["commits"]
        if "tag" in commit
    ]
    assert sorted([features["base"]["branch"], *forks]) == sorted(pins["branches"])
    assert sorted(tags) == sorted(pins["tags"])
    roles = [feature["role"] for feature in features["features"]]
    assert roles.count("originating") == 1
    assert set(roles) == {"originating", "running"}


def test_builder_refuses_a_source_outside_the_fixture(tmp_path: Path):
    copy = tmp_path / "fixture"
    shutil.copytree(BUILDER.parent, copy)
    features = json.loads((copy / "features.json").read_text())
    features["features"][0]["commits"][0]["source"] = "../../etc"
    (copy / "features.json").write_text(json.dumps(features))
    result = subprocess.run(
        [sys.executable, str(copy / "build.py"), str(tmp_path / "repo")],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "outside the fixture" in result.stderr
    assert not (tmp_path / "repo").exists()


def test_builder_refuses_a_malformed_features_file(tmp_path: Path):
    copy = tmp_path / "fixture"
    shutil.copytree(BUILDER.parent, copy)
    (copy / "features.json").write_text('{"base": {"branch": "main"}}')
    result = subprocess.run(
        [sys.executable, str(copy / "build.py"), str(tmp_path / "repo")],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "cannot read features.json" in result.stderr
