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
