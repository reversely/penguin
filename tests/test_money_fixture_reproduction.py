"""Reproduce the money-minor-units case on its fixture: what breaks, where, and which fix mends it.

Follows docs/fixture-money.md. Every expectation is read from examples/money-minor-units/larder.json:
each fix commit names the tests it makes pass, and a checkpoint
may name tests that fail on it alone. The impact and side-by-side checks run Penguin's own analysis
scripts from services/local-bridge/analysis on the built repository.
"""

import io
import json
import subprocess
import sys
import tarfile
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "examples" / "money-minor-units"
ANALYSIS = ROOT / "services" / "local-bridge" / "analysis"
RAW = json.loads((FIXTURE / "larder.json").read_text())
FEATURES = {feature["id"]: feature for feature in RAW["features"]}
(ORIGINATING,) = [f for f in RAW["features"] if f["role"] == "originating"]
INES = f"feature-{ORIGINATING['id']}"
STEPS = [f"{INES}-{commit['tag']}" for commit in ORIGINATING["commits"]]
WITH_FIX = [f["id"] for f in RAW["features"] if f["role"] in {"reader", "midway"}]
RUNNING_AT_CHECKPOINT = [
    f["id"]
    for f in RAW["features"]
    if f["role"] in {"reader", "unaffected", "same-area"}
    and f["id"] not in {p["feature"] for p in RAW["promotions"]}
]


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=check, capture_output=True, text=True
    )


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


def merged(repo: Path, first: str, second: str) -> str:
    result = git(repo, "merge-tree", "--write-tree", first, second, check=False)
    assert result.returncode == 0, f"{first} and {second} conflict:\n{result.stdout}"
    return result.stdout.split()[0]


def failed_tests(tree: Path, command: str = "python -m pytest") -> tuple[int, set[str]]:
    """Run a test command in ``tree`` and return its exit status and failed test IDs."""
    result = subprocess.run(
        f"{command} -rf",
        check=False,
        shell=True,
        cwd=tree,
        capture_output=True,
        text=True,
    )
    assert result.returncode in {0, 1}, result.stdout + result.stderr
    failed = {
        line.removeprefix("FAILED ").split(" - ")[0]
        for line in result.stdout.splitlines()
        if line.startswith("FAILED ")
    }
    return result.returncode, failed


@pytest.fixture(scope="module")
def repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    target = tmp_path_factory.mktemp("money") / "repo"
    subprocess.run(
        [sys.executable, str(FIXTURE / "build.py"), str(target)],
        check=True,
        capture_output=True,
    )
    return target


@pytest.fixture(scope="module")
def scopes(repo: Path) -> dict[str, dict]:
    return {
        s["id"]: s
        for s in json.loads((repo / "penguin" / "scopes.json").read_text())["scopes"]
    }


def scope_of(scopes: dict[str, dict], path: str) -> str | None:
    for scope in scopes.values():
        for prefix in (p.rstrip("/") for p in scope["paths"]):
            if path == prefix or path.startswith(prefix + "/"):
                return scope["id"]
    return None


def changed_scopes(
    repo: Path, scopes: dict[str, dict], feature_id: str, ref: str
) -> list[str]:
    start = "base" if FEATURES[feature_id]["start"] == "base" else "main"
    paths = git(repo, "diff", "--name-only", f"{start}...{ref}").stdout.split()
    return sorted({scope_of(scopes, path) for path in paths} - {None})


def fixed_by(commit: dict) -> list[str]:
    return commit.get("fix", {}).get("tests", [])


def expected_failures(step: int) -> set[str]:
    """Tests failing on Ines's fork after ``step``: those a later step fixes."""
    return {
        test for later in ORIGINATING["commits"][step + 1 :] for test in fixed_by(later)
    }


@pytest.mark.parametrize("ref", ["base", "main"])
def test_every_scope_passes_on_main(repo: Path, scopes: dict, tmp_path: Path, ref: str):
    tree = extract(repo, ref, tmp_path)
    for scope in scopes.values():
        assert failed_tests(tree, scope["test_command"]) == (0, set()), (
            ref,
            scope["id"],
        )


@pytest.mark.parametrize("step", range(len(STEPS)), ids=STEPS)
def test_ines_fork_fails_until_each_fix(repo: Path, tmp_path: Path, step: int):
    expected = expected_failures(step)
    assert failed_tests(extract(repo, STEPS[step], tmp_path)) == (
        1 if expected else 0,
        expected,
    )


def test_pins_map_each_fixed_test_to_its_commit(repo: Path):
    pins = json.loads((FIXTURE / "pins.json").read_text())
    for feature in RAW["features"]:
        for commit in feature["commits"]:
            for test in fixed_by(commit):
                ref = f"feature-{feature['id']}" + (
                    f"-{commit['tag']}" if "tag" in commit else ""
                )
                assert (
                    pins["fixes"][test] == git(repo, "rev-parse", ref).stdout.strip()
                ), test


@pytest.mark.parametrize("feature_id", WITH_FIX)
def test_running_feature_breaks_on_ines_fork_until_its_fix(
    repo: Path, scopes: dict, tmp_path: Path, feature_id: str
):
    (fix,) = [c for c in FEATURES[feature_id]["commits"] if "fix" in c]
    command = scopes[fix["fix"]["scope"]]["test_command"]
    checkpoint = f"feature-{feature_id}-checkpoint"
    before = extract(repo, merged(repo, INES, checkpoint), tmp_path / "before")
    assert failed_tests(before, command) == (1, set(fixed_by(fix)))
    after = extract(
        repo, merged(repo, INES, f"feature-{feature_id}"), tmp_path / "after"
    )
    assert failed_tests(after, command) == (0, set())


@pytest.mark.parametrize(
    "feature_id", [f["id"] for f in RAW["features"] if f["role"] != "originating"]
)
def test_each_checkpoint_passes_alone_but_for_its_named_failures(
    repo: Path, scopes: dict, tmp_path: Path, feature_id: str
):
    checkpoint = f"feature-{feature_id}-checkpoint"
    (commit,) = [
        c for c in FEATURES[feature_id]["commits"] if c.get("tag") == "checkpoint"
    ]
    tree = extract(repo, checkpoint, tmp_path)
    failed = set()
    for scope_id in changed_scopes(repo, scopes, feature_id, checkpoint):
        failed |= failed_tests(tree, scopes[scope_id]["test_command"])[1]
    assert failed == set(commit.get("fails_alone", []))


@pytest.mark.parametrize(
    "feature_id",
    [f["id"] for f in RAW["features"] if f["role"] in {"unaffected", "late-starter"}],
)
def test_features_outside_the_plan_pass_on_ines_fork(
    repo: Path, scopes: dict, tmp_path: Path, feature_id: str
):
    ref = f"feature-{feature_id}"
    tree = extract(repo, merged(repo, INES, ref), tmp_path)
    for scope_id in changed_scopes(repo, scopes, feature_id, ref):
        assert failed_tests(tree, scopes[scope_id]["test_command"]) == (0, set()), (
            scope_id
        )


def test_rounding_mode_touches_other_functions_than_ines(
    repo: Path, scopes: dict, tmp_path: Path
):
    tree = extract(
        repo, merged(repo, f"{INES}-checkpoint", "feature-rounding-mode"), tmp_path
    )
    assert failed_tests(tree, scopes["money"]["test_command"]) == (0, set())


def test_fix_commits_change_only_their_scope(repo: Path, scopes: dict):
    for feature in RAW["features"]:
        for commit in feature["commits"]:
            if "fix" not in commit:
                continue
            ref = f"feature-{feature['id']}" + (
                f"-{commit['tag']}" if "tag" in commit else ""
            )
            paths = git(repo, "diff", "--name-only", f"{ref}^", ref).stdout.split()
            allowed = (
                {commit["fix"]["scope"], "money"}
                if commit["fix"]["scope"] == "promotions"
                else {commit["fix"]["scope"]}
            )
            assert paths and {scope_of(scopes, p) for p in paths} <= allowed, (
                ref,
                paths,
            )


def impact(repo: Path, base: str, head: str, forks: list[dict]) -> dict:
    request = {"base": base, "head": head, "forks": forks}
    result = subprocess.run(
        [sys.executable, "-I", str(ANALYSIS / "python_impact.py"), "--repo", str(repo)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def fork_request(repo: Path, scopes: dict, feature_id: str, tag: str) -> dict:
    ref = f"feature-{feature_id}-{tag}"
    return {
        "id": feature_id,
        "sha": git(repo, "rev-parse", ref).stdout.strip(),
        "scopes": changed_scopes(repo, scopes, feature_id, ref),
    }


def test_impact_of_ines_checkpoint_finds_23_readers_in_nine_scopes(
    repo: Path, scopes: dict
):
    sha = lambda ref: git(repo, "rev-parse", ref).stdout.strip()
    forks = [fork_request(repo, scopes, f, "checkpoint") for f in RUNNING_AT_CHECKPOINT]
    forks.append(fork_request(repo, scopes, "pagination", "checkpoint-1"))
    report = impact(repo, sha("main"), sha(f"{INES}-checkpoint"), forks)
    assert report["complete"]
    selected = {
        fork["id"] for fork in report["forks"] if fork["uses"] or fork["errors"]
    }
    readers = {f["id"] for f in RAW["features"] if f["role"] == "reader"}
    same_area = {f["id"] for f in RAW["features"] if f["role"] == "same-area"} & set(
        RUNNING_AT_CHECKPOINT
    )
    assert selected == readers | same_area
    assert len(readers) == 23
    reader_scopes = {
        s for fork in report["forks"] if fork["id"] in readers for s in fork["scopes"]
    }
    assert reader_scopes == {part["scope"] for part in RAW["plan"]["parts"]}
    changed = {change["symbol"] for change in report["changes"]}
    assert {
        "shared.money.price",
        "shared.money.total",
        "shared.money.display",
        "shared.money.Money",
    } <= changed

    midway = impact(
        repo,
        sha("main"),
        sha(f"{INES}-checkpoint"),
        [fork_request(repo, scopes, "pagination", "checkpoint")],
    )
    assert midway["forks"][0]["uses"]


def side_by_side(tree: Path, request: dict) -> list[dict]:
    result = subprocess.run(
        [sys.executable, "-I", str(ANALYSIS / "side_by_side.py"), "--tree", str(tree)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)["results"]


def half_up(amount: Decimal) -> int:
    return int(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def exact_tax(record: dict, rates: dict[str, str], per_line: bool) -> int:
    """An order's tax in cents in exact decimal arithmetic, rounded half up."""
    rate = Decimal(rates[record["region"]])
    cents = [
        Decimal(str(line["unit_price"])).scaleb(2) * line["quantity"]
        for line in record["lines"]
    ]
    if per_line:
        return sum(half_up(amount * rate) for amount in cents)
    return half_up(sum(cents) * rate)


@pytest.mark.parametrize(
    ("step", "per_line"), [("fix-analytics", False), ("tax-per-line", True)]
)
def test_tax_side_by_side_matches_exact_arithmetic_on_the_fork(
    repo: Path, scopes: dict, tmp_path: Path, step: str, per_line: bool
):
    """The fork's tax equals the exact tax on every order, so every difference the run reports is
    either the whole-order rounding or main's float arithmetic."""
    (example,) = RAW["examples"]
    rates = example["sample"]["rates"]
    cases = json.loads((repo / example["file"]).read_text())["cases"]
    request = {
        "contracts": [c for scope in scopes.values() for c in scope["contracts"]],
        "calls": [
            {"id": c["name"], "contract": example["contract"], "args": c["args"]}
            for c in cases
        ],
    }
    main = side_by_side(extract(repo, "main", tmp_path / "main"), request)
    fork = side_by_side(extract(repo, f"{INES}-{step}", tmp_path / "fork"), request)
    assert all(r["status"] == "returned" for r in main + fork)
    records = [c["args"]["order"]["args"]["record"] for c in cases]
    assert [r["value"] for r in fork] == [
        exact_tax(r, rates, per_line) for r in records
    ]
    gaps = [abs(m["value"] - f["value"]) for m, f in zip(main, fork, strict=True)]
    if per_line:
        # Main's floats can round an exact half-cent line tax down, by at most a cent per order.
        assert max(gaps) <= 1
    else:
        assert any(gaps)
