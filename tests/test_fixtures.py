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


# Larder runs PRD cases 1 to 3 before case 4. Each row merges a case's originating commit onto an
# affected feature, as Penguin's block check does, and names the tests the merged tree fails.
LARDER_CASES = [
    (
        "accounts-merge-checkpoint",
        "cohort-ltv-checkpoint",
        {
            "analytics/tests/test_kiosk.py::test_shared_device_split",
            "analytics/tests/test_retention.py::test_dau_stable",
        },
    ),
    (
        "accounts-merge-checkpoint",
        "weekly-digest-checkpoint",
        {"messaging/tests/test_consent.py::test_unsubscribe_survives"},
    ),
    ("accounts-merge-limit-one", "cohort-ltv-cutover", set()),
    ("accounts-merge-limit-one", "weekly-digest-consent", set()),
    (
        "structured-logs-checkpoint",
        "holiday-closures-checkpoint",
        {
            "store_dashboard/tests/test_holidays.py::test_a_closure_covers_the_stores_whole_local_day"
        },
    ),
    (
        "structured-logs-checkpoint",
        "weekly-digest-consent",
        {
            "messaging/tests/test_digest_schedule.py::test_goes_out_at_the_local_hour_west_of_utc"
        },
    ),
    ("structured-logs-local-day", "holiday-closures-local-day", set()),
    ("structured-logs-local-day", "weekly-digest-local-day", set()),
    (
        "dependency-audit-checkpoint",
        "instant-payouts-checkpoint",
        {"payouts/tests/test_send.py::test_timed_out_payout_is_paid_once"},
    ),
    (
        "dependency-audit-checkpoint",
        "tip-jar-checkpoint",
        {"checkout/tests/test_tip_charge.py::test_timed_out_tip_is_charged_once"},
    ),
    ("dependency-audit-checkpoint", "instant-payouts-keys", set()),
    ("dependency-audit-checkpoint", "tip-jar-keys", set()),
]


@pytest.fixture(scope="module")
def larder(tmp_path_factory: pytest.TempPathFactory) -> Path:
    target = tmp_path_factory.mktemp("larder") / "repo"
    subprocess.run(
        [
            sys.executable,
            "-I",
            str(EXAMPLES / "money-minor-units" / "build.py"),
            str(target),
        ],
        check=True,
        capture_output=True,
    )
    return target


def failing_tests(repo: Path, tree: str, into: Path) -> set[str]:
    into.mkdir()
    archive = subprocess.run(
        ["git", "-C", str(repo), "archive", tree], check=True, capture_output=True
    )
    subprocess.run(["tar", "-x", "-C", str(into)], input=archive.stdout, check=True)
    run = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-rf",
            "--no-header",
            "-p",
            "no:cacheprovider",
        ],
        cwd=into,
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode in (0, 1), run.stdout[-2000:]
    return {
        line.split(" ")[1]
        for line in run.stdout.splitlines()
        if line.startswith("FAILED")
    }


@pytest.mark.slow
@pytest.mark.parametrize(("change", "affected", "fails"), LARDER_CASES)
def test_each_larder_case_fails_on_its_merged_checkpoints_and_passes_with_its_fixes(
    larder: Path, tmp_path: Path, change: str, affected: str, fails: set[str]
) -> None:
    merged = subprocess.run(
        [
            "git",
            "-C",
            str(larder),
            "merge-tree",
            "--write-tree",
            f"feature-{change}",
            f"feature-{affected}",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()[0]
    assert failing_tests(larder, merged, tmp_path / "tree") == fails


def git_out(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


# Cases 1 and 3 (#178): no agent writes into another person's fork. Penguin's update of each affected
# fork copies the originating change's modules byte for byte and rewrites the fork's call sites with
# the plan's rules; the fork then passes its own tests alone and takes the promoted change with no
# conflict in the copies. The build runs Penguin's codemod, so the test builds Larder itself.
def test_each_larder_fork_penguin_updates_holds_the_originating_modules_and_passes_alone(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "larder"
    subprocess.run(
        [
            sys.executable,
            "-I",
            str(EXAMPLES / "money-minor-units" / "build.py"),
            str(repo),
        ],
        check=True,
        capture_output=True,
    )
    data = json.loads((EXAMPLES / "money-minor-units" / "larder.json").read_text())
    updates = [
        (feature["id"], commit["tag"], commit["update"])
        for feature in data["features"]
        for commit in feature["commits"]
        if "update" in commit
    ]
    assert len(updates) == 4
    for fork, tag, update in updates:
        head = f"feature-{fork}-{tag}"
        source = f"feature-{update['from']}-{update['tag']}"
        for path in update["copies"]:
            assert git_out(repo, "rev-parse", f"{head}:{path}") == git_out(
                repo, "rev-parse", f"{source}:{path}"
            ), f"{fork} {path}"
        assert failing_tests(repo, head, tmp_path / fork) == set(), fork
        # The originating change's head is what main moves to at its promotion.
        promoted = next(
            f"feature-{each['id']}-{each['commits'][-1]['tag']}"
            for each in data["features"]
            if each["id"] == update["from"]
        )
        merged = subprocess.run(
            ["git", "-C", str(repo), "merge-tree", "--write-tree", head, promoted],
            check=False,
            capture_output=True,
            text=True,
        )
        assert merged.returncode == 0, merged.stdout
