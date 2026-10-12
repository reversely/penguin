"""The four use-case fixtures (examples/) build to the commits pinned in each pins.json, so every
machine and every test runs the same history. Their team and identity files describe the people the
PRD names: each scope's DRI is a member of its team, and each agent may change only its person's
scopes."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
FIXTURES = [
    "identity-unification",
    "helpful-fix",
    "dependency-bump",
    "money-minor-units",
]


@pytest.mark.slow
@pytest.mark.parametrize("fixture", FIXTURES)
def test_the_fixture_builds_to_its_pinned_commits(fixture: str, tmp_path: Path) -> None:
    target = tmp_path / fixture
    subprocess.run(
        [sys.executable, "-I", str(EXAMPLES / fixture / "build.py"), str(target)],
        check=True,
        capture_output=True,
        text=True,
    )
    refs = subprocess.run(
        [
            "git",
            "-C",
            str(target),
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    pins = json.loads((EXAMPLES / fixture / "pins.json").read_text())
    assert dict(line.split() for line in refs.splitlines()) == {
        **pins["branches"],
        **pins["tags"],
    }


def penguin_files(fixture: str) -> dict[str, dict]:
    base = EXAMPLES / fixture / "base" / "penguin"
    return {
        name: json.loads((base / f"{name}.json").read_text())
        for name in ("scopes", "teams", "identities")
    }


@pytest.mark.parametrize(
    "fixture", ["identity-unification", "helpful-fix", "dependency-bump"]
)
def test_each_scope_dri_is_on_its_team_and_each_agent_changes_only_its_persons_scopes(
    fixture: str,
) -> None:
    files = penguin_files(fixture)
    members = {team["id"]: set(team["members"]) for team in files["teams"]["teams"]}
    dri_of = {}
    for scope in files["scopes"]["scopes"]:
        dri = scope.get("dri", scope.get("owner"))
        dri_of[scope["id"]] = dri
        if "team" in scope:
            assert dri in members[scope["team"]], scope["id"]
            assert set(scope.get("fallback", [])) <= members[scope["team"]], scope["id"]
    for identity in files["identities"]["identities"]:
        owner = identity["owner"]
        for scope in identity["charter_scopes"]:
            assert dri_of[scope] == owner, f"{identity['handle']} names {scope}"
