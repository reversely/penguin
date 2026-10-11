"""Reproduce the two combined-test failures of the helpful-fix fixture and their fixes.

Follows docs/fixture-helpful-fix.md: build the fixture, run each scope's tests on each checkpoint
alone, merge Priya's commits with Jun's and Sam's and run their tests on the merged trees, then
merge the three checkpoints and the three fixed branches and run every scope's tests.
"""

import io
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

FIXTURE = Path(__file__).resolve().parents[1] / "examples" / "helpful-fix"
# Each owner's checkpoint, and Priya's fix, which adds start_of_local_day. Jun's and Sam's fix
# commits import start_of_local_day, so their tests run on trees merged with Priya's fix.
COMMITS = (
    "owner-priya-checkpoint",
    "owner-jun-checkpoint",
    "owner-sam-checkpoint",
    "owner-priya",
)
WEEKLY_LOCAL_DAY = (
    "analytics/tests/test_weekly.py::"
    "test_evening_activity_west_of_utc_stays_on_its_local_day"
)
REMINDER_LOCAL_HOUR = (
    "messaging/tests/test_reminders.py::test_fires_at_the_local_hour_west_of_utc"
)
# (Priya's commit, the other owner's commit, the scope whose tests run, the tests that fail).
MERGES = (
    (
        "owner-priya-checkpoint",
        "owner-jun-checkpoint",
        "analytics",
        {WEEKLY_LOCAL_DAY},
    ),
    (
        "owner-priya-checkpoint",
        "owner-sam-checkpoint",
        "messaging",
        {REMINDER_LOCAL_HOUR},
    ),
    ("owner-priya", "owner-jun-checkpoint", "analytics", {WEEKLY_LOCAL_DAY}),
    ("owner-priya", "owner-sam-checkpoint", "messaging", {REMINDER_LOCAL_HOUR}),
    ("owner-priya", "owner-jun", "analytics", set()),
    ("owner-priya", "owner-sam", "messaging", set()),
)
# The branch whose head fixes each test, and the scope that fix may change.
FIXES = {
    WEEKLY_LOCAL_DAY: ("owner-jun", "analytics"),
    REMINDER_LOCAL_HOUR: ("owner-sam", "messaging"),
}
# Host timezones east of, at and west of UTC. The failing tests set each user's offset themselves,
# so the host timezone must not change which tests fail.
HOST_TIMEZONES = ("UTC", "Asia/Tokyo", "America/Los_Angeles")
PINS = json.loads((FIXTURE / "pins.json").read_text())
# The throwaway merge commit needs an identity; fixed values keep the run independent of the
# caller's Git configuration.
MERGE_ENV = {
    "GIT_AUTHOR_NAME": "Penguin Fixture",
    "GIT_AUTHOR_EMAIL": "fixture@penguin.invalid",
    "GIT_COMMITTER_NAME": "Penguin Fixture",
    "GIT_COMMITTER_EMAIL": "fixture@penguin.invalid",
}


def git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=None if env is None else {**os.environ, **env},
    ).stdout.strip()


def merged_tree(repo: Path, first: str, second: str) -> str:
    return git(repo, "merge-tree", "--write-tree", first, second)


def merged_three(repo: Path, priya: str, jun: str, sam: str) -> str:
    """Merge three commits and return the tree; `git merge-tree` merges two at a time."""
    priya_and_jun = git(
        repo,
        "commit-tree",
        merged_tree(repo, priya, jun),
        "-p",
        priya,
        "-p",
        jun,
        "-m",
        f"Merge {priya} and {jun}",
        env=MERGE_ENV,
    )
    return merged_tree(repo, priya_and_jun, sam)


def extract(repo: Path, treeish: str, destination: Path) -> Path:
    """Write the files of ``treeish`` into ``destination`` without touching the repository."""
    archive = subprocess.run(
        ["git", "-C", str(repo), "archive", "--format=tar", treeish],
        check=True,
        capture_output=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(destination, filter="data")
    return destination


def failed_tests(
    tree: Path, command: str, host_timezone: str | None = None
) -> tuple[int, set[str]]:
    """Run a scope's test command in ``tree`` and return its exit status and failed test IDs."""
    env = None if host_timezone is None else {**os.environ, "TZ": host_timezone}
    result = subprocess.run(
        f"{command} -rf",
        check=False,
        shell=True,
        cwd=tree,
        capture_output=True,
        text=True,
        env=env,
    )
    failed = {
        line.removeprefix("FAILED ").split(" - ")[0]
        for line in result.stdout.splitlines()
        if line.startswith("FAILED ")
    }
    return result.returncode, failed


@pytest.fixture(scope="module")
def built_repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    target = tmp_path_factory.mktemp("fixture") / "repo"
    subprocess.run(
        [sys.executable, str(FIXTURE / "build.py"), str(target)],
        check=True,
        capture_output=True,
    )
    return target


@pytest.fixture(scope="module")
def scopes(built_repo: Path) -> dict[str, dict]:
    scopes = json.loads((built_repo / "penguin" / "scopes.json").read_text())["scopes"]
    return {scope["id"]: scope for scope in scopes}


@pytest.fixture(scope="module")
def test_commands(scopes: dict[str, dict]) -> dict[str, str]:
    return {scope_id: scope["test_command"] for scope_id, scope in scopes.items()}


@pytest.mark.parametrize("commit", COMMITS)
def test_every_scope_passes_on_each_commit_alone(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path, commit: str
):
    tree = extract(built_repo, commit, tmp_path)
    for scope, command in test_commands.items():
        assert failed_tests(tree, command) == (0, set()), f"{scope} on {commit}"


@pytest.mark.parametrize(("priya", "other", "scope", "expected"), MERGES)
def test_merged_tree_fails_exactly_the_expected_tests(
    built_repo: Path,
    test_commands: dict[str, str],
    tmp_path: Path,
    priya: str,
    other: str,
    scope: str,
    expected: set[str],
):
    tree = extract(built_repo, merged_tree(built_repo, priya, other), tmp_path)
    status, failed = failed_tests(tree, test_commands[scope])
    assert (status, failed) == (1 if expected else 0, expected)


@pytest.mark.parametrize("host_timezone", HOST_TIMEZONES)
def test_merged_checkpoints_fail_the_same_two_tests_in_any_host_timezone(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path, host_timezone: str
):
    tree = extract(
        built_repo,
        merged_three(
            built_repo,
            "owner-priya-checkpoint",
            "owner-jun-checkpoint",
            "owner-sam-checkpoint",
        ),
        tmp_path,
    )
    results = {
        scope: failed_tests(tree, command, host_timezone)
        for scope, command in test_commands.items()
    }
    assert results == {
        "ingestion": (0, set()),
        "analytics": (1, {WEEKLY_LOCAL_DAY}),
        "messaging": (1, {REMINDER_LOCAL_HOUR}),
    }


def test_combined_run_on_the_fixed_branches_passes(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path
):
    tree = extract(
        built_repo,
        merged_three(built_repo, "owner-priya", "owner-jun", "owner-sam"),
        tmp_path,
    )
    for scope, command in test_commands.items():
        assert failed_tests(tree, command) == (0, set()), scope


@pytest.mark.parametrize("test_id", sorted(FIXES))
def test_pins_map_each_test_to_its_fix_commit(built_repo: Path, test_id: str):
    branch, _ = FIXES[test_id]
    assert PINS["fixes"][test_id] == git(built_repo, "rev-parse", branch)


@pytest.mark.parametrize(
    ("commit", "scope"), [*FIXES.values(), ("owner-priya", "ingestion")]
)
def test_each_fix_commit_changes_only_its_owner_scope(
    built_repo: Path, scopes: dict[str, dict], commit: str, scope: str
):
    changed = git(built_repo, "diff", "--name-only", f"{commit}^", commit).split()
    paths = tuple(scopes[scope]["paths"])
    assert changed
    assert all(path.startswith(paths) for path in changed)
