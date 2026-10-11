"""Reproduce the combined-test failure of the dependency-bump fixture and its fix.

Follows docs/fixture-dependency-bump.md: build the fixture, run each scope's tests on each checkpoint
alone, merge Hugo's upgrade with Ana's checkpoint and run every scope's tests on the merged tree, then
merge Hugo's branch with Ana's fixed branch and run every scope's tests.
"""

import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

FIXTURE = Path(__file__).resolve().parents[1] / "examples" / "dependency-bump"
# Each owner's checkpoint, and Ana's fix, which also passes on the old client alone.
COMMITS = ("owner-hugo-checkpoint", "owner-ana-checkpoint", "owner-ana")
TIMED_OUT_CHARGE = (
    "payments/tests/test_webhooks.py::test_timed_out_charge_is_charged_once"
)
# The assertion message the failing test prints when the processor charged the order twice.
DOUBLE_CHARGE = "2 charges for one payment of order ord_1003"
# The branch whose head fixes each test, and the scope that fix may change.
FIXES = {TIMED_OUT_CHARGE: ("owner-ana", "payments")}
PINS = json.loads((FIXTURE / "pins.json").read_text())


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def merged_tree(repo: Path, first: str, second: str) -> str:
    return git(repo, "merge-tree", "--write-tree", first, second)


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


def run_tests(tree: Path, command: str) -> tuple[int, set[str], str]:
    """Run a scope's test command in ``tree``; return its exit status, failed IDs and output."""
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
    return result.returncode, failed, result.stdout


def failed_tests(tree: Path, command: str) -> tuple[int, set[str]]:
    status, failed, _ = run_tests(tree, command)
    return status, failed


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


def test_merged_checkpoints_charge_the_timed_out_order_twice(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path
):
    tree = extract(
        built_repo,
        merged_tree(built_repo, "owner-hugo-checkpoint", "owner-ana-checkpoint"),
        tmp_path,
    )
    assert failed_tests(tree, test_commands["platform"]) == (0, set())
    status, failed, output = run_tests(tree, test_commands["payments"])
    assert (status, failed) == (1, {TIMED_OUT_CHARGE})
    assert DOUBLE_CHARGE in output


def test_combined_run_on_the_fixed_branches_passes(
    built_repo: Path, test_commands: dict[str, str], tmp_path: Path
):
    tree = extract(
        built_repo, merged_tree(built_repo, "owner-hugo", "owner-ana"), tmp_path
    )
    for scope, command in test_commands.items():
        assert failed_tests(tree, command) == (0, set()), scope


def test_hugo_has_no_fix_commit(built_repo: Path):
    assert git(built_repo, "rev-parse", "owner-hugo") == git(
        built_repo, "rev-parse", "owner-hugo-checkpoint"
    )


@pytest.mark.parametrize("test_id", sorted(FIXES))
def test_pins_map_each_test_to_its_fix_commit(built_repo: Path, test_id: str):
    branch, _ = FIXES[test_id]
    assert PINS["fixes"][test_id] == git(built_repo, "rev-parse", branch)


@pytest.mark.parametrize(
    ("commit", "scope"),
    [
        *FIXES.values(),
        ("owner-hugo-checkpoint", "platform"),
        ("owner-ana-checkpoint", "payments"),
    ],
)
def test_each_owner_commit_changes_only_its_owner_scope(
    built_repo: Path, scopes: dict[str, dict], commit: str, scope: str
):
    changed = git(built_repo, "diff", "--name-only", f"{commit}^", commit).split()
    paths = tuple(scopes[scope]["paths"])
    assert changed
    # A running feature also declares its own contracts and examples in the penguin files.
    outside = {path for path in changed if not path.startswith(paths)}
    assert outside <= {"penguin/scopes.json", "penguin/invariants.json"}
    for name in outside:
        before, after = (
            json.loads(git(built_repo, "show", f"{ref}:{name}"))
            for ref in (f"{commit}^", commit)
        )
        assert others(before, scope) == others(after, scope), name


def others(declaration: dict, scope: str) -> list[dict]:
    """The entries of a penguin file that belong to scopes other than ``scope``."""
    entries = [
        *declaration.get("scopes", []),
        *declaration.get("invariants", []),
        *declaration.get("examples", []),
    ]
    return [
        entry for entry in entries if scope not in (entry.get("id"), entry.get("scope"))
    ]
