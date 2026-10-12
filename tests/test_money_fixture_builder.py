"""Checks on the money-minor-units fixture builder (examples/money-minor-units/build.py).

The fixture models docs/case-study-money.md. These checks cover the build itself, the counts the case
study names, the recorded tax sample and the loader's refusals of hostile data. The slow checks of
which tests fail where are in test_money_fixture_reproduction.py.
"""

import copy
import importlib.util
import itertools
import json
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURE = Path(__file__).resolve().parents[1] / "examples" / "money-minor-units"
BUILDER = FIXTURE / "build.py"
PINS = json.loads((FIXTURE / "pins.json").read_text())
RAW = json.loads((FIXTURE / "larder.json").read_text())


def load_builder():
    spec = importlib.util.spec_from_file_location("money_fixture_build", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load_builder()


def run_builder(target: Path, *flags: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUILDER), str(target), *flags],
        check=False,
        capture_output=True,
        text=True,
    )


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def refs_of(repo: Path) -> dict[str, str]:
    lines = git(repo, "for-each-ref", "--format=%(refname:short) %(objectname)")
    return dict(line.split() for line in lines.splitlines())


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict]:
    target = tmp_path_factory.mktemp("money") / "repo"
    result = run_builder(target, "--pins")
    assert result.returncode == 0, result.stderr
    return target, json.loads(result.stdout)


@pytest.fixture(scope="module")
def penguin(built: tuple[Path, dict]) -> dict[str, dict]:
    repo, _ = built
    return {
        name: json.loads((repo / "penguin" / f"{name}.json").read_text())
        for name in ("owners", "scopes", "identities", "invariants")
    }


def test_rebuilding_produces_identical_refs_and_trees(built, tmp_path: Path):
    first, _ = built
    second = tmp_path / "second"
    second.mkdir()  # an existing empty directory is accepted as well as a missing one
    assert run_builder(second).returncode == 0
    assert refs_of(first) == refs_of(second)
    assert git(first, "rev-parse", "main^{tree}") == git(
        second, "rev-parse", "main^{tree}"
    )


def test_build_reproduces_the_pinned_shas(built):
    repo, printed = built
    assert refs_of(repo) == {**PINS["branches"], **PINS["tags"]}
    assert printed == PINS


def test_build_leaves_a_clean_checkout_of_main(built):
    repo, _ = built
    assert git(repo, "status", "--porcelain") == ""
    assert git(repo, "rev-parse", "HEAD") == PINS["branches"]["main"]


def test_counts_match_the_case_study(built, penguin):
    repo, _ = built
    scopes = {scope["id"]: scope for scope in penguin["scopes"]["scopes"]}
    assert len(scopes) == 14
    assert len(penguin["owners"]["owners"]) == 14
    assert {scope["owner"] for scope in scopes.values()} == {
        owner["id"] for owner in penguin["owners"]["owners"]
    }
    plan_scopes = {part["scope"] for part in RAW["plan"]["parts"]}
    assert len(plan_scopes) == 9
    kinds = [part["kind"] for part in RAW["plan"]["parts"]]
    assert (kinds.count("mechanical"), kinds.count("behavioural")) == (6, 3)

    # A fork is affected when its latest checkpoint changes a path in a scope of the plan.
    def scope_of(path: str) -> str | None:
        for scope in scopes.values():
            for prefix in scope["paths"]:
                if path == prefix.rstrip("/") or path.startswith(
                    prefix.rstrip("/") + "/"
                ):
                    return scope["id"]
        return None

    affected = set()
    for feature in RAW["features"]:
        if feature["role"] in {"originating", "wave"}:
            continue
        checkpoint = f"feature-{feature['id']}-checkpoint"
        start = "base" if feature["start"] == "base" else "main"
        changed = git(
            repo, "diff", "--name-only", f"{start}...{checkpoint}"
        ).splitlines()
        if plan_scopes & {scope_of(path) for path in changed}:
            affected.add(feature["id"])
    assert len(affected) == 24
    assert {
        f["id"] for f in RAW["features"] if f["role"] in {"reader", "midway"}
    } == affected


def test_mechanical_and_behavioural_fixes_match_the_plan():
    (ines,) = [f for f in RAW["features"] if f["role"] == "originating"]
    fixes = [c["fix"] for c in ines["commits"] if "fix" in c]
    planned = {part["scope"]: part["kind"] for part in RAW["plan"]["parts"]}
    on_main = {
        fix["scope"]: fix["kind"]
        for fix in fixes
        if fix["scope"] in planned and fix["kind"] != "revision"
    }
    assert on_main == planned
    assert [fix["scope"] for fix in fixes if fix["kind"] == "revision"] == ["tax"]
    midway = [
        c["fix"]
        for f in RAW["features"]
        if f["role"] == "midway"
        for c in f["commits"]
        if "fix" in c and "after" not in c
    ]
    assert [fix["kind"] for fix in midway] == ["mechanical"]
    assert sum(kind == "mechanical" for kind in on_main.values()) + len(midway) == 7


def test_invariants_name_tax_per_line_and_a_protected_revenue_file(penguin):
    invariants = {i["id"]: i for i in penguin["invariants"]["invariants"]}
    assert invariants["tax-per-line"]["statement"] == "Tax is rounded per line item"
    assert invariants["revenue-matches-orders"]["protected"] is True
    (analytics,) = [s for s in penguin["scopes"]["scopes"] if s["id"] == "analytics"]
    assert analytics["protected_paths"] == ["analytics/revenue_report.py"]


def test_scopes_claim_disjoint_paths_and_hold_their_contracts(penguin):
    claimed = [
        (prefix.rstrip("/"), scope["id"])
        for scope in penguin["scopes"]["scopes"]
        for prefix in scope["paths"]
    ]
    for prefix, scope_id in claimed:
        for other, other_id in claimed:
            if scope_id != other_id:
                assert not (prefix == other or prefix.startswith(other + "/")), (
                    prefix,
                    other,
                )
    for scope in penguin["scopes"]["scopes"]:
        for contract in scope["contracts"]:
            path = contract.partition("::")[0]
            assert any(path.startswith(p.rstrip("/") + "/") for p in scope["paths"]), (
                contract
            )


def test_identities_give_each_feature_an_agent_of_its_owner(penguin):
    identities = penguin["identities"]["identities"]
    waves = [f for f in RAW["features"] if f["role"] == "wave"]
    assert len(identities) == len(RAW["features"]) == 40 + len(waves)
    assert all(i["handle"].startswith(f"@{i['owner']}/") for i in identities)
    assert len({i["handle"] for i in identities}) == len(identities)


def test_tax_sample_keeps_every_drawn_order(built):
    repo, _ = built
    examples = json.loads((repo / "tax" / "examples" / "invoice_tax.json").read_text())
    sample = RAW["examples"][0]["sample"]
    assert examples["contract"] == "tax/invoice.py::invoice_tax_minor"
    assert [case["name"] for case in examples["cases"]] == [
        f"order-{n:04d}" for n in range(1, sample["orders"] + 1)
    ]
    records = [case["args"]["order"]["args"]["record"] for case in examples["cases"]]
    assert records == build.sampled_orders(sample)
    counts = {len(record["lines"]) for record in records}
    assert counts == set(range(1, sample["max_lines"] + 1))


def test_examples_file_is_inside_the_tax_scope(penguin):
    (entry,) = penguin["invariants"]["examples"]
    assert entry == {
        "scope": "tax",
        "file": "tax/examples/invoice_tax.json",
        "invariants": ["tax-per-line", "tax-region-rate"],
    }


def mutate(path: tuple, value) -> dict:
    raw = copy.deepcopy(RAW)
    node = raw
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return raw


HOSTILE = [
    (("scopes", 0, "id"), "../money"),
    (("scopes", 0, "id"), "money; rm -rf /"),
    (("scopes", 0, "id"), "$(touch pwned)"),
    (("scopes", 0, "id"), "Money"),
    (("scopes", 0, "id"), "-rf"),
    (("scopes", 1, "paths"), ["../outside/"]),
    (("scopes", 1, "paths"), ["/etc/"]),
    (("scopes", 1, "paths"), ["checkout/../../x/"]),
    (("scopes", 1, "paths"), ["-rf/"]),
    (("scopes", 1, "paths"), ["check out/"]),
    (("scopes", 1, "contracts"), ["../checkout/cart.py::cart_total"]),
    (("scopes", 1, "contracts"), ["orders/model.py::Order"]),
    (("scopes", 9, "protected_paths"), ["../analytics/revenue_report.py"]),
    (("people", 0, "id"), "ines\nevil"),
    (("people", 0, "display_name"), "Ines <ines@x>\ncommitter Mallory"),
    (("authors", "codemod", "email"), "codemod@penguin.invalid>\n"),
    (("features", 0, "id"), "money/../../etc"),
    (("features", 0, "agent"), "@ines/money"),
    (("features", 0, "commits", 0, "source"), "../../base"),
    (("features", 0, "commits", 0, "tag"), "--force"),
    (("features", 0, "commits", 0, "date"), "2026-03-05T10:00:00"),
    (("features", 0, "commits", 1, "fix", "tests"), ["../tests/test_x.py::test_y"]),
    (("examples", 0, "file"), "orders/examples/invoice_tax.json"),
    (("features", 3, "commits", 2, "after"), "--force"),
    (("features", 3, "commits", 2, "after"), "fix"),
]


@pytest.mark.parametrize(("path", "value"), HOSTILE, ids=[repr(v) for _, v in HOSTILE])
def test_loader_refuses_hostile_names(path: tuple, value):
    with pytest.raises(build.LarderError) as refused:
        build.load_larder(mutate(path, value))
    assert refused.value.problems


def test_loader_accepts_the_fixture_data():
    larder = build.load_larder(copy.deepcopy(RAW))
    assert len(larder.scopes) == 14
    assert len(larder.features) == 47


def test_builder_refuses_a_hostile_larder_before_writing(tmp_path: Path, monkeypatch):
    target = tmp_path / "repo"
    monkeypatch.setattr(
        build,
        "read_larder",
        lambda: build.load_larder(mutate(("scopes", 0, "id"), "../x")),
    )
    assert build.main([str(target)]) == 2
    assert not target.exists()


def test_builder_refuses_a_non_empty_target(tmp_path: Path):
    target = tmp_path / "repo"
    target.mkdir()
    (target / "keep.txt").write_text("existing\n")
    result = run_builder(target)
    assert result.returncode != 0
    assert "not empty" in result.stderr
    assert [p.name for p in target.iterdir()] == ["keep.txt"]


def test_builder_writes_only_inside_the_target(tmp_path: Path):
    assert run_builder(tmp_path / "repo").returncode == 0
    assert [p.name for p in tmp_path.iterdir()] == ["repo"]


def test_waves_form_one_chain_from_main(built):
    """Each wave starts where main stood and main moves to each wave's head in turn."""
    repo, _ = built
    waves = [f["id"] for f in RAW["features"] if f["role"] == "wave"]
    assert waves[0] == "money-type" and waves[-1] == "money-contract"
    for earlier, later in itertools.pairwise(waves):
        first = f"feature-{later}-checkpoint^"
        assert git(repo, "rev-parse", first) == git(
            repo, "rev-parse", f"feature-{earlier}"
        )
    assert git(repo, "rev-parse", "main") == git(
        repo, "rev-parse", f"feature-{waves[-1]}"
    )


def test_a_wave_fix_leaves_the_feature_branch_at_its_one_block_fix(built):
    """A running feature's second fix is built on its checkpoint beside the first."""
    repo, _ = built
    for feature in RAW["features"]:
        for commit in feature["commits"]:
            if "after" not in commit:
                continue
            ref = f"feature-{feature['id']}"
            side = f"{ref}-{commit['tag']}"
            assert git(repo, "rev-parse", f"{side}^") == git(
                repo, "rev-parse", f"{ref}-{commit['after']}"
            )
            assert git(repo, "rev-parse", ref) != git(repo, "rev-parse", side)
