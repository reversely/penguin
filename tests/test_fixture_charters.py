"""Each fixture's agent identities name only their owner's scopes in their charters.

Penguin refuses an identity whose charter names a scope whose DRI is another person, so the
dashboard preview and the walkthrough create each identity from ``penguin/identities.json`` on main
as the fixture writes it. A feature that reaches into another person's scope says so in its area,
and its builder names that scope's paths in ``charter_paths``. Each person has one steward,
chartered on every scope they are DRI for, and each feature has one builder.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
FIXTURES = (
    "identity-unification",
    "helpful-fix",
    "dependency-bump",
    "money-minor-units",
)


def main_file(repo: Path, path: str) -> dict:
    shown = subprocess.run(
        ["git", "-C", str(repo), "show", f"main:{path}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(shown.stdout)


@pytest.mark.parametrize("fixture", FIXTURES)
def test_every_charter_names_only_its_owners_scopes(tmp_path: Path, fixture: str):
    repo = tmp_path / "repo"
    subprocess.run(
        [sys.executable, str(EXAMPLES / fixture / "build.py"), str(repo)],
        check=True,
        capture_output=True,
    )
    scopes = main_file(repo, "penguin/scopes.json")["scopes"]
    dri_of = {scope["id"]: scope["dri"] for scope in scopes}
    identities = main_file(repo, "penguin/identities.json")["identities"]
    assert identities
    for identity in identities:
        assert identity["charter_scopes"] or identity.get("charter_paths"), identity[
            "handle"
        ]
        assert {dri_of[scope] for scope in identity["charter_scopes"]} <= {
            identity["owner"]
        }, identity["handle"]
    stewards = {i["owner"]: i for i in identities if i["handle"].endswith("/steward")}
    assert set(stewards) == set(dri_of.values())
    for person, steward in stewards.items():
        assert sorted(steward["charter_scopes"]) == sorted(
            scope for scope, dri in dri_of.items() if dri == person
        )
