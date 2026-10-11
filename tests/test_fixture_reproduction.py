"""Reproduce the three combined-test failures of the identity-unification fixture.

Follows docs/fixture.md: build the fixture, run each scope's tests on each checkpoint branch, then
merge owner-priya with owner-jun and with owner-sam and run Jun's and Sam's tests on the merged
trees.
"""

import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

FIXTURE = Path(__file__).resolve().parents[1] / "examples" / "identity-unification"
CHECKPOINTS = ("owner-priya", "owner-jun", "owner-sam")
EXPECTED_FAILURES = {
    "owner-jun": {
        "analytics/tests/test_retention.py::test_dau_stable",
        "analytics/tests/test_identity.py::test_shared_device_split",
    },
    "owner-sam": {"messaging/tests/test_consent.py::test_unsubscribe_survives"},
}
OWNER_SCOPE = {"owner-jun": "analytics", "owner-sam": "messaging"}


def git(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True
    ).stdout


def extract(repo: Path, treeish: str, destination: Path) -> Path:
    """Write the files of ``treeish`` into ``destination`` without touching the repository."""
    archive = git(repo, "archive", "--format=tar", treeish)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(destination, filter="data")
    return destination


def failed_tests(tree: Path, command: str) -> tuple[int, set[str]]:
    """Run a scope's test command in ``tree`` and return its exit status and failed test IDs."""
    result = subprocess.run(
        f"{command} -rf",
        check=False,
        shell=True,
        cwd=tree,
        capture_output=True,
        text=True,
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
def test_commands(built_repo: Path) -> dict[str, str]:
    scopes = json.loads((built_repo / "penguin" / "scopes.json").read_text())["scopes"]
    return {scope["id"]: scope["test_command"] for scope in scopes}


@pytest.mark.parametrize("branch", CHECKPOINTS)
def test_every_scope_passes_on_each_checkpoint_alone(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path, branch: str
):
    tree = extract(built_repo, branch, tmp_path)
    for scope, command in test_commands.items():
        assert failed_tests(tree, command) == (0, set()), f"{scope} on {branch}"


@pytest.mark.parametrize("owner", sorted(OWNER_SCOPE))
def test_merging_priya_checkpoint_fails_only_the_expected_tests(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path, owner: str
):
    merged = git(built_repo, "merge-tree", "--write-tree", "owner-priya", owner)
    tree = extract(built_repo, merged.decode().strip(), tmp_path)
    status, failed = failed_tests(tree, test_commands[OWNER_SCOPE[owner]])
    assert status == 1
    assert failed == EXPECTED_FAILURES[owner]
