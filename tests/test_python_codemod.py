"""Checks on Penguin's codemod for mechanical interface changes (services/local-bridge/analysis/python_codemod.py)."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CODEMOD = ROOT / "services" / "local-bridge" / "analysis" / "python_codemod.py"

RENAME = {
    "kind": "rename",
    "from": "shared.dates.start_of_day",
    "to": "shared.dates.start_of_local_day",
}


def run(tree: Path, request: object) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(CODEMOD), "--tree", str(tree)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=False,
    )


def write(tree: Path, files: dict[str, str]) -> None:
    for name, text in files.items():
        path = tree / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def test_rename_rewrites_each_import_form(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "a/from_import.py": "from shared.dates import start_of_day\n\nx = start_of_day(1)\n",
            "a/module_import.py": "import shared.dates\n\nx = shared.dates.start_of_day(1)\n",
            "a/unrelated.py": "from other import start_of_day\n\nx = start_of_day(1)\n",
        },
    )
    paths = ["a/from_import.py", "a/module_import.py", "a/unrelated.py"]
    result = run(tmp_path, {"edits": [RENAME], "paths": paths})
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert [entry["path"] for entry in report["changed"]] == [
        "a/from_import.py",
        "a/module_import.py",
    ]
    assert report["unchanged"] == ["a/unrelated.py"]
    assert (tmp_path / "a/from_import.py").read_text() == (
        "from shared.dates import start_of_local_day\n\nx = start_of_local_day(1)\n"
    )
    assert (
        "shared.dates.start_of_local_day(1)"
        in (tmp_path / "a/module_import.py").read_text()
    )
    assert (
        (tmp_path / "a/unrelated.py")
        .read_text()
        .startswith("from other import start_of_day")
    )


def test_rename_parameter_rewrites_only_calls_of_the_function(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "a/calls.py": "from shared.dates import day, other\n\nday(1, zone=2)\nother(zone=3)\n"
        },
    )
    edit = {
        "kind": "rename-parameter",
        "function": "shared.dates.day",
        "from": "zone",
        "to": "offset",
    }
    result = run(tmp_path, {"edits": [edit], "paths": ["a/calls.py"]})
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "a/calls.py").read_text() == (
        "from shared.dates import day, other\n\nday(1, offset=2)\nother(zone=3)\n"
    )


def test_paths_that_leave_the_checkout_are_refused_and_never_opened(
    tmp_path: Path,
) -> None:
    tree = tmp_path / "tree"
    outside = tmp_path / "outside"
    write(outside, {"secret.py": "from shared.dates import start_of_day\n"})
    write(tree, {"a/ok.py": "x = 1\n", "a/data.txt": "x\n"})
    (tree / "a" / "link.py").symlink_to(outside / "secret.py")
    (tree / "linked").symlink_to(outside)
    paths = [
        "a/link.py",
        "linked/secret.py",
        "../outside/secret.py",
        "/etc/hosts",
        "a/./ok.py",
        "a/data.txt",
        "a/missing.py",
    ]
    result = run(tree, {"edits": [RENAME], "paths": paths})
    assert result.returncode == 0, result.stderr
    errors = {
        entry["path"]: entry["message"] for entry in json.loads(result.stdout)["errors"]
    }
    assert errors == {
        "a/link.py": "a symlink",
        "linked/secret.py": "a symlink",
        "../outside/secret.py": "not a normalised relative path",
        "/etc/hosts": "not a normalised relative path",
        "a/./ok.py": "not a normalised relative path",
        "a/data.txt": "not a Python file",
        "a/missing.py": "missing",
    }
    assert (
        outside / "secret.py"
    ).read_text() == "from shared.dates import start_of_day\n"


@pytest.mark.parametrize(
    "request_body",
    [
        "not json",
        {"edits": [], "paths": []},
        {"edits": [{"kind": "exec", "code": "import os"}], "paths": []},
        {
            "edits": [{"kind": "rename", "from": "a.b; import os", "to": "a.c"}],
            "paths": [],
        },
        {
            "edits": [{"kind": "rename", "from": "a.b", "to": "a.c", "extra": 1}],
            "paths": [],
        },
        {"edits": [RENAME], "paths": [], "shell": "rm -rf /"},
    ],
)
def test_a_malformed_request_exits_2_and_writes_nothing(
    tmp_path: Path, request_body: object
) -> None:
    write(tmp_path, {"a/x.py": "from shared.dates import start_of_day\n"})
    body = request_body if isinstance(request_body, str) else json.dumps(request_body)
    result = subprocess.run(
        [sys.executable, "-I", str(CODEMOD), "--tree", str(tmp_path)],
        input=body,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""
    assert (
        tmp_path / "a/x.py"
    ).read_text() == "from shared.dates import start_of_day\n"


# Rewrite rules a merge plan declares (PRD 4.2 step 4).

MONEY = '''"""Prices in minor units."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Money:
    amount_minor: int
    currency: str

    def display(self) -> str:
        return str(self.amount_minor)

    def times(self, quantity: int) -> "Money":
        return Money(self.amount_minor * quantity, self.currency)


def price(amount_minor: int, currency: str) -> Money:
    return Money(amount_minor, currency)


def total(prices: list[Money]) -> Money:
    return prices[0]
'''
CONTRACTS = {"shared/money/__init__.py": MONEY}


def rule(rule_id: str, symbol: str, pattern: str, replacement: str, **fields) -> dict:
    return {
        "id": rule_id,
        "contract": f"shared/money/__init__.py::{symbol}",
        "kind": fields.get("kind", "expression"),
        "pattern": pattern,
        "replacement": replacement,
        "imports": fields.get("imports", []),
    }


DISPLAY = rule("display", "display", "money.display($amount)", "$amount.display()")


def rules_request(rules: list[dict], paths: list[str]) -> dict:
    return {"rules": rules, "contracts": CONTRACTS, "paths": paths}


def test_an_expression_rule_rewrites_each_use_of_its_contract_however_it_is_imported(
    tmp_path: Path,
) -> None:
    write(
        tmp_path,
        {
            "a/module.py": "from shared import money\n\nx = money.display(1)\n",
            "a/name.py": "from shared.money import display\n\nx = display(total)\n",
            "a/aliased.py": "import shared.money as m\n\nx = f'{m.display(a - b)}'\ny = m.total([])\n",
            "a/other.py": "from other import money\n\nx = money.display(1)\n",
        },
    )
    paths = ["a/module.py", "a/name.py", "a/aliased.py", "a/other.py"]
    result = run(tmp_path, rules_request([DISPLAY], paths))
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["refused"] == []
    assert report["changed"] == [
        {"path": "a/module.py", "rules": ["display"]},
        {"path": "a/name.py", "rules": ["display"]},
        {"path": "a/aliased.py", "rules": ["display"]},
    ]
    assert report["unchanged"] == ["a/other.py"]
    # The import the rewrite left unused goes; one still used stays. The runner formats afterwards.
    assert (tmp_path / "a/module.py").read_text().lstrip() == "x = (1).display()\n"
    assert (tmp_path / "a/name.py").read_text().lstrip() == "x = total.display()\n"
    assert (tmp_path / "a/aliased.py").read_text() == (
        "import shared.money as m\n\nx = f'{(a - b).display()}'\ny = m.total([])\n"
    )


def test_annotation_rules_retype_returns_and_parameters_that_reach_the_contract(
    tmp_path: Path,
) -> None:
    source = (
        "from shared import money\n\n\n"
        "def due(amount: float, rate: float) -> float:\n"
        "    return money.price(amount)\n\n\n"
        "def ratio(a: float) -> float:\n"
        "    return a / 2\n"
    )
    write(tmp_path, {"a/fees.py": source})
    annotation = rule(
        "price-annotation", "price", "float", "money.Money", kind="annotation"
    )
    result = run(tmp_path, rules_request([annotation], ["a/fees.py"]))
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "a/fees.py").read_text() == (
        "from shared import money\n\n\n"
        "def due(amount: money.Money, rate: float) -> money.Money:\n"
        "    return money.price(amount)\n\n\n"
        "def ratio(a: float) -> float:\n"
        "    return a / 2\n"
    )


def test_a_replacement_adds_the_imports_it_declares(tmp_path: Path) -> None:
    write(
        tmp_path,
        {"a/tip.py": "from shared import money\n\nx = money.price(cart * pct / 100)\n"},
    )
    scaled = rule(
        "price-percent",
        "price",
        "money.price($amount * $percent / 100)",
        "$amount.times(Decimal($percent))",
        imports=[{"module": "decimal", "name": "Decimal"}],
    )
    result = run(tmp_path, rules_request([scaled], ["a/tip.py"]))
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "a/tip.py").read_text() == (
        "from decimal import Decimal\n\nx = cart.times(Decimal(pct))\n"
    )


@pytest.mark.parametrize(
    ("bad", "reason"),
    [
        (
            rule("cents", "price", "round($amount * 100)", "$amount.amount_minor"),
            "names no use of shared.money.price, so it would rewrite code outside its contract",
        ),
        (
            rule("os", "display", "money.display($x)", "os.system($x)"),
            "names os, which neither shared.money nor the rule's imports provide",
        ),
        (
            rule("attr", "display", "money.display($x)", "$x.__class__"),
            "reaches .__class__, which shared.money does not define",
        ),
        (
            rule("lambda", "display", "money.display($x)", "(lambda: $x)()"),
            "may not hold a Lambda",
        ),
        (
            rule(
                "vendor",
                "display",
                "money.display($x)",
                "fmt($x)",
                imports=[{"module": "vendor.fmt", "name": "fmt"}],
            ),
            "from shared.money or the standard library",
        ),
        (
            rule("syntax", "display", "money.display($x", "$x.display()"),
            "does not parse as a Python expression",
        ),
        (
            rule("unbound", "display", "money.display($x)", "$y.display()"),
            "uses $y, which the pattern does not bind",
        ),
        (
            {**DISPLAY, "id": "elsewhere", "contract": "shared/other.py::display"},
            "shared/other.py is not in the checkpoint",
        ),
    ],
)
def test_a_rule_outside_its_contract_or_its_names_is_refused_and_not_applied(
    tmp_path: Path, bad: dict, reason: str
) -> None:
    source = (
        "import os\n\nfrom shared import money\n\nx = round(money.display(y) * 100)\n"
    )
    write(tmp_path, {"a/x.py": source})
    result = run(tmp_path, rules_request([bad], ["a/x.py"]))
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert [entry["rule"] for entry in report["refused"]] == [bad["id"]]
    assert reason in report["refused"][0]["message"]
    assert report["rules"] == []
    assert (tmp_path / "a/x.py").read_text() == source


@pytest.mark.parametrize(
    "request_body",
    [
        {"rules": [], "contracts": {}, "paths": []},
        {"rules": [{**DISPLAY, "code": "import os"}], "contracts": {}, "paths": []},
        {"rules": [{**DISPLAY, "kind": "exec"}], "contracts": {}, "paths": []},
        {"rules": [DISPLAY, DISPLAY], "contracts": {}, "paths": []},
        {"rules": [DISPLAY], "edits": [RENAME], "contracts": {}, "paths": []},
    ],
)
def test_a_malformed_rules_request_exits_2(
    tmp_path: Path, request_body: object
) -> None:
    result = run(tmp_path, request_body)
    assert result.returncode == 2
    assert result.stdout == ""
