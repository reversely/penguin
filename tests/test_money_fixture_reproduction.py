"""Reproduce the money-minor-units case on its fixture: what breaks, where, and which fix mends it.

Follows docs/fixture-money.md. Every expectation is read from examples/money-minor-units/larder.json:
each migration and revision names the tests it makes pass, and a checkpoint may name tests that
fail on it alone. The impact and side-by-side checks run Penguin's own analysis
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
# Ines's split: the first commit is the expand, the last the contract.
EXPAND = f"{INES}-{ORIGINATING['commits'][0]['tag']}"
CONTRACT = f"{INES}-{ORIGINATING['commits'][-1]['tag']}"
MIGRATING = [f["id"] for f in RAW["features"] if f["role"] in {"reader", "midway"}]


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


def failing_files(tree: Path, command: str) -> set[str]:
    """The test files with a failing test or a module that does not import, under ``command``."""
    result = subprocess.run(
        f"{command} -rfE --continue-on-collection-errors",
        check=False,
        shell=True,
        cwd=tree,
        capture_output=True,
        text=True,
    )
    return {
        line.split()[1].split("::")[0]
        for line in result.stdout.splitlines()
        if line.startswith(("FAILED ", "ERROR "))
    }


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


def fixed_by(commit: dict) -> list[str]:
    return commit.get("fix", {}).get("tests", [])


def tagged(feature: dict, commit: dict) -> str:
    return f"feature-{feature['id']}-{commit['tag']}"


def expected_failures(feature: dict, step: int) -> set[str]:
    """Tests failing on a feature's commit ``step``: those it names and those a later commit fixes."""
    commits = feature["commits"]
    later = {test for c in commits[step + 1 :] for test in fixed_by(c)}
    return later | set(commits[step].get("fails_alone", []))


@pytest.mark.parametrize("ref", ["base", "main"])
def test_every_scope_passes_on_main(repo: Path, scopes: dict, tmp_path: Path, ref: str):
    tree = extract(repo, ref, tmp_path)
    for scope in scopes.values():
        assert failed_tests(tree, scope["test_command"]) == (0, set()), (
            ref,
            scope["id"],
        )


COMMITS = [
    (feature["id"], step)
    for feature in RAW["features"]
    for step in range(len(feature["commits"]))
]


@pytest.mark.parametrize(
    ("feature_id", "step"), COMMITS, ids=[f"{f}-{s}" for f, s in COMMITS]
)
def test_each_commit_fails_only_what_it_names_or_a_later_commit_fixes(
    repo: Path, tmp_path: Path, feature_id: str, step: int
):
    feature = FEATURES[feature_id]
    tree = extract(repo, tagged(feature, feature["commits"][step]), tmp_path)
    expected = expected_failures(feature, step)
    assert failed_tests(tree) == (1 if expected else 0, expected)


def test_pins_map_each_fixed_test_to_its_commit(repo: Path):
    pins = json.loads((FIXTURE / "pins.json").read_text())
    for feature in RAW["features"]:
        for commit in feature["commits"]:
            for test in fixed_by(commit):
                sha = git(repo, "rev-parse", tagged(feature, commit)).stdout.strip()
                assert pins["fixes"][test] == sha, test


@pytest.mark.parametrize("feature_id", MIGRATING)
def test_running_feature_breaks_once_the_float_api_leaves_main_until_it_migrates(
    repo: Path, scopes: dict, tmp_path: Path, feature_id: str
):
    feature = FEATURES[feature_id]
    command = scopes[feature["area"][0]]["test_command"]
    checkpoint = tagged(feature, feature["commits"][0])
    later = [c for c in feature["commits"][1:] if "fix" not in c]
    if later:
        checkpoint = tagged(feature, later[-1])
    before = extract(repo, merged(repo, CONTRACT, checkpoint), tmp_path / "before")
    assert failing_files(before, command)
    (migrate,) = [
        c for c in feature["commits"] if c.get("fix", {}).get("kind") == "migration"
    ]
    after = extract(
        repo, merged(repo, CONTRACT, tagged(feature, migrate)), tmp_path / "after"
    )
    assert failed_tests(after, command) == (0, set())


@pytest.mark.parametrize(
    ("feature_id", "origin"),
    [(f["id"], CONTRACT) for f in RAW["features"] if f["role"] == "unaffected"]
    + [(f["id"], CONTRACT) for f in RAW["features"] if f["role"] == "late-starter"]
    + [(f["id"], EXPAND) for f in RAW["features"] if f["role"] == "same-area"],
)
def test_features_outside_the_split_pass_with_it(
    repo: Path, scopes: dict, tmp_path: Path, feature_id: str, origin: str
):
    ref = f"feature-{feature_id}"
    tree = extract(repo, merged(repo, origin, ref), tmp_path)
    for scope_id in FEATURES[feature_id]["area"]:
        assert failed_tests(tree, scopes[scope_id]["test_command"]) == (0, set()), (
            scope_id
        )


def test_each_migration_changes_only_its_area(repo: Path, scopes: dict):
    for feature in RAW["features"]:
        for commit in feature["commits"]:
            if "fix" not in commit:
                continue
            ref = tagged(feature, commit)
            # A reader's migration merges main first: its own change is against main.
            paths = git(repo, "diff", "--name-only", f"{ref}^1", ref).stdout.split()
            assert paths and {scope_of(scopes, p) for p in paths} <= set(
                feature["area"]
            ), (ref, paths)


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


def test_the_expand_only_adds_and_reaches_no_running_feature(repo: Path, scopes: dict):
    sha = lambda ref: git(repo, "rev-parse", ref).stdout.strip()
    forks = [
        {
            "id": f["id"],
            "sha": sha(tagged(f, f["commits"][0])),
            "scopes": list(f["area"]),
        }
        for f in RAW["features"]
        if f["start"] == "base" and f["id"] != RAW["promotions"][0]["feature"]
    ]
    report = impact(repo, sha(f"{EXPAND}^"), sha(EXPAND), forks)
    assert report["complete"]
    assert {change["change"] for change in report["changes"]} == {"added"}
    assert report["signatures"] == [] and report["removedExports"] == []
    assert report["dataShapes"] == []
    assert {"shared.money.Money", "orders.model.line_total_minor"} <= {
        change["symbol"] for change in report["changes"]
    }


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


(TAX,) = [
    f
    for f in RAW["features"]
    if any(c.get("fix", {}).get("kind") == "revision" for c in f["commits"])
]
TAX_STEPS = [tagged(TAX, c) for c in TAX["commits"]]


@pytest.mark.parametrize(
    ("fork", "per_line"), [(TAX_STEPS[0], False), (TAX_STEPS[-1], True)]
)
def test_tax_side_by_side_matches_exact_arithmetic_on_the_block(
    repo: Path, scopes: dict, tmp_path: Path, fork: str, per_line: bool
):
    """The block's tax equals the exact tax on every order, so every difference the run reports is
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
    main = side_by_side(extract(repo, f"{TAX_STEPS[0]}^", tmp_path / "main"), request)
    block = side_by_side(extract(repo, fork, tmp_path / "block"), request)
    assert all(r["status"] == "returned" for r in main + block)
    records = [c["args"]["order"]["args"]["record"] for c in cases]
    assert [r["value"] for r in block] == [
        exact_tax(r, rates, per_line) for r in records
    ]
    gaps = [abs(m["value"] - f["value"]) for m, f in zip(main, block, strict=True)]
    if per_line:
        # Main's floats can round an exact half-cent line tax down, by at most a cent per order.
        assert max(gaps) <= 1
    else:
        assert any(gaps)


def test_main_ends_with_no_float_api(repo: Path):
    money = git(repo, "show", "main:shared/money/__init__.py").stdout
    orders = git(repo, "show", "main:orders/model.py").stdout
    discounts = git(repo, "show", "main:shared/money/discounts.py").stdout
    assert "\ndef price(" not in money and "\ndef total(" not in money
    assert "\ndef percent_off(" not in discounts
    assert "\ndef line_total(" not in orders and "\ndef order_total(" not in orders
    assert (
        git(repo, "rev-parse", "main").stdout == git(repo, "rev-parse", CONTRACT).stdout
    )
