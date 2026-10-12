"""Build the pinned money-minor-units fixture repository from larder.json.

Usage: python build.py TARGET [--pins]

TARGET must be an empty directory or a path that does not exist yet. The builder reads every person,
scope, invariant, feature and commit from ``larder.json`` next to this script, checks them all, then
creates a Git repository in TARGET:

- The base commit holds the files under ``base/`` plus the generated ``penguin/owners.json``,
  ``penguin/scopes.json``, ``penguin/identities.json`` and ``penguin/invariants.json``, and each
  generated examples file. It is ``main`` and the tag ``base``.
- Each feature is the branch ``feature-<id>``, started from ``base`` or from ``main`` as it stands at
  the feature's first commit. Each commit lays the files under ``features/<id>/<source>/`` over the
  branch's tree, so a source directory holds only the files the commit adds or changes. A commit with
  a ``tag`` also gets the lightweight tag ``feature-<id>-<tag>``.
- A commit with ``after`` names the tag of an earlier commit of its feature. It is built on that
  commit and keeps only its own tag; the branch head stays where it was. A running feature uses it
  for a second fix of the same checkpoint: one per plan that reaches it.
- A promotion moves ``main`` to a feature's head, as Penguin promotes a block in one push.

Commits and promotions are applied in date order. Every value Git hashes is fixed (author, committer,
dates, message, file bytes and modes), so every machine gets the same commit SHAs. ``pins.json``
records them; ``--pins`` prints the pins of the build as JSON instead of one ref per line.

The builder runs only local Git commands, makes no network request and writes only inside TARGET.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
LARDER = HERE / "larder.json"

# Files a local test run leaves in a source directory; they never belong in a commit.
SKIPPED_DIRS = frozenset({"__pycache__", ".pytest_cache"})
SKIPPED_SUFFIXES = frozenset({".pyc", ".pyo"})

ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
# A file name in a source directory may also be a dot file such as .gitignore, never '.' or '..'.
FILE_SEGMENT = re.compile(r"^(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$")
SYMBOL = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
TEST_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*\.py::test_[A-Za-z0-9_]+$")
# Names and addresses go into commit headers, so they hold no '<', '>' or line break.
NAME = re.compile(r"^[A-Za-z][A-Za-z .'-]{0,63}$")
EMAIL = re.compile(r"^[a-z0-9._-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
VENDORS = frozenset({"claude-code", "codex"})
STARTS = frozenset({"base", "main"})
ROLES = frozenset(
    {
        "originating",
        "wave",
        "same-area",
        "reader",
        "midway",
        "unaffected",
        "late-starter",
    }
)
FIX_KINDS = frozenset({"mechanical", "behavioural", "revision"})
MAX_ID = 64
MAX_TEXT = 2000
MAX_PATH = 512


class LarderError(ValueError):
    """larder.json breaks the format; ``problems`` lists every field at fault."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__(
            "invalid larder.json:\n" + "\n".join(f"  {p}" for p in problems)
        )
        self.problems = problems


# Loading and checking larder.json. Every name that reaches a path, a ref, a commit header or a
# command is checked here, so a hostile data file cannot write outside TARGET, break the import
# stream or name a ref Git would read as an option.


@dataclass(frozen=True)
class CommitSpec:
    feature: str
    source: str
    date: str
    message: str
    author: str
    tag: str | None
    fix: dict | None
    fails_alone: list[str]
    after: str | None = None


@dataclass(frozen=True)
class Larder:
    raw: dict
    people: dict[str, dict]
    scopes: dict[str, dict]
    # Each scope's paths, normalised without the trailing '/'.
    scope_paths: dict[str, list[str]]
    features: dict[str, dict]
    commits: list[CommitSpec]


class Checker:
    """Collects every problem in larder.json, so one run reports them all."""

    def __init__(self) -> None:
        self.problems: list[str] = []

    def fail(self, where: str, message: str) -> None:
        self.problems.append(f"{where}: {message}")

    def id(self, value: object, where: str) -> bool:
        if isinstance(value, str) and len(value) <= MAX_ID and ID.fullmatch(value):
            return True
        self.fail(where, f"{value!r} is not lowercase words joined by '-'")
        return False

    def name(self, value: object, where: str) -> None:
        if not isinstance(value, str) or not NAME.fullmatch(value):
            self.fail(where, f"{value!r} is not a plain name")

    def email(self, value: object, where: str) -> None:
        if not isinstance(value, str) or not EMAIL.fullmatch(value):
            self.fail(where, f"{value!r} is not a plain email address")

    def text(self, value: object, where: str) -> None:
        if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT:
            self.fail(where, f"must be text of at most {MAX_TEXT} characters")

    def path(self, value: object, where: str) -> str | None:
        """A relative path inside the repository; a trailing '/' marks a directory prefix."""
        if not isinstance(value, str) or not value or len(value) > MAX_PATH:
            self.fail(where, f"{value!r} is not a path")
            return None
        segments = value.removesuffix("/").split("/")
        if value.startswith("/") or not all(
            SEGMENT.fullmatch(s) and s not in {".", ".."} for s in segments
        ):
            self.fail(where, f"{value!r} is not a relative path of plain segments")
            return None
        return "/".join(segments)

    def date(self, value: object, where: str) -> datetime | None:
        try:
            parsed = datetime.fromisoformat(value) if isinstance(value, str) else None
        except ValueError:
            parsed = None
        if parsed is None or parsed.utcoffset() is None:
            self.fail(where, f"{value!r} is not an ISO date with a time zone")
            return None
        return parsed

    def contract(self, contract: object, paths: list[str], where: str) -> None:
        path, _, symbol = (
            contract.partition("::") if isinstance(contract, str) else ("", "", "")
        )
        checked = self.path(path, where) if path else None
        if not checked or not checked.endswith(".py") or not SYMBOL.fullmatch(symbol):
            self.fail(where, f"contract {contract!r} is not path.py::symbol")
        elif not inside(checked, paths):
            self.fail(where, f"contract {contract!r} is outside the scope's paths")

    def test_ids(self, names: object, where: str) -> list[str]:
        if not isinstance(names, list):
            self.fail(where, "must be a list of pytest node IDs")
            return []
        for name in names:
            if not isinstance(name, str) or not TEST_ID.fullmatch(name) or ".." in name:
                self.fail(where, f"{name!r} is not a pytest node ID")
        return names


def inside(path: str, prefixes: list[str]) -> bool:
    return any(path == p or path.startswith(p + "/") for p in prefixes)


def check_people(raw: dict, check: Checker) -> dict[str, dict]:
    for role, author in raw.get("authors", {}).items():
        check.name(author.get("name"), f"authors.{role}.name")
        check.email(author.get("email"), f"authors.{role}.email")
    people = {}
    for i, person in enumerate(raw.get("people", [])):
        check.name(person.get("display_name"), f"people[{i}].display_name")
        if check.id(person.get("id"), f"people[{i}].id"):
            if person["id"] in people:
                check.fail(f"people[{i}].id", f"repeats {person['id']!r}")
            people[person["id"]] = person
    return people


def check_scopes(
    raw: dict, people: dict, check: Checker
) -> tuple[dict[str, dict], dict[str, list[str]]]:
    scopes, scope_paths = {}, {}
    for i, scope in enumerate(raw.get("scopes", [])):
        at = f"scopes[{i}]"
        if not check.id(scope.get("id"), f"{at}.id"):
            continue
        if scope["id"] in scopes:
            check.fail(f"{at}.id", f"repeats {scope['id']!r}")
        check.text(scope.get("name"), f"{at}.name")
        if scope.get("owner") not in people:
            check.fail(f"{at}.owner", f"{scope.get('owner')!r} is not a person")
        paths = [check.path(p, f"{at}.paths") for p in scope.get("paths", [])]
        if not paths:
            check.fail(f"{at}.paths", "must list at least one path")
        scopes[scope["id"]] = scope
        scope_paths[scope["id"]] = [p for p in paths if p]
        for p in scope.get("protected_paths", []):
            path = check.path(p, f"{at}.protected_paths")
            if path and not inside(path, scope_paths[scope["id"]]):
                check.fail(f"{at}.protected_paths", f"{p!r} is outside the scope")
    for scope_id, scope in scopes.items():
        for provider in scope.get("depends_on", []):
            if provider not in scopes or provider == scope_id:
                check.fail(
                    f"scope {scope_id}", f"depends on unknown scope {provider!r}"
                )
        for contract in scope.get("contracts", []):
            check.contract(contract, scope_paths[scope_id], f"scope {scope_id}")
    return scopes, scope_paths


def check_invariants(raw: dict, scope_paths: dict, check: Checker) -> None:
    declared = {}
    for i, invariant in enumerate(raw.get("invariants", [])):
        if check.id(invariant.get("id"), f"invariants[{i}].id"):
            declared[invariant["id"]] = invariant.get("scope")
        if invariant.get("scope") not in scope_paths:
            check.fail(
                f"invariants[{i}].scope", f"{invariant.get('scope')!r} is not a scope"
            )
        check.text(invariant.get("statement"), f"invariants[{i}].statement")
    for i, example in enumerate(raw.get("examples", [])):
        at, scope_id = f"examples[{i}]", example.get("scope")
        path = check.path(example.get("file"), f"{at}.file")
        if scope_id not in scope_paths:
            check.fail(f"{at}.scope", f"{scope_id!r} is not a scope")
        elif path and not inside(path, scope_paths[scope_id]):
            check.fail(f"{at}.file", f"{path!r} is outside scope {scope_id}")
        for name in example.get("invariants", []):
            if declared.get(name) != scope_id:
                check.fail(f"{at}.invariants", f"{name!r} is not the scope's")


def check_commit(
    commit: dict, feature: dict, at: str, people: dict, scopes: dict, check: Checker
) -> CommitSpec | None:
    before = len(check.problems)
    source = commit.get("source")
    if not isinstance(source, str) or not SEGMENT.fullmatch(source):
        check.fail(f"{at}.source", f"{source!r} is not one directory name")
    if commit.get("tag") is not None:
        check.id(commit["tag"], f"{at}.tag")
    check.date(commit.get("date"), f"{at}.date")
    check.text(commit.get("message"), f"{at}.message")
    author = commit.get("author", "owner")
    if author not in {"owner", "codemod"} and author not in people:
        check.fail(f"{at}.author", f"{author!r} is not 'owner', 'codemod' or a person")
    fix = commit.get("fix")
    if fix is not None:
        if fix.get("scope") not in scopes or fix.get("kind") not in FIX_KINDS:
            check.fail(f"{at}.fix", f"needs a scope and a kind in {sorted(FIX_KINDS)}")
        check.test_ids(fix.get("tests", []), f"{at}.fix.tests")
    fails_alone = check.test_ids(commit.get("fails_alone", []), f"{at}.fails_alone")
    after = commit.get("after")
    if after is not None:
        check.id(after, f"{at}.after")
        if commit.get("tag") is None:
            check.fail(f"{at}.tag", "a commit built after another needs its own tag")
    if len(check.problems) > before:
        return None
    return CommitSpec(
        feature=feature["id"],
        source=source,
        date=commit["date"],
        message=commit["message"],
        author=author,
        tag=commit.get("tag"),
        fix=fix,
        fails_alone=fails_alone,
        after=after,
    )


def check_features(
    raw: dict, people: dict, scopes: dict, check: Checker
) -> tuple[dict[str, dict], list[CommitSpec]]:
    features, commits = {}, []
    for i, feature in enumerate(raw.get("features", [])):
        at = f"features[{i}]"
        if not check.id(feature.get("id"), f"{at}.id"):
            continue
        if feature["id"] in features:
            check.fail(f"{at}.id", f"repeats {feature['id']!r}")
        features[feature["id"]] = feature
        if feature.get("owner") not in people:
            check.fail(f"{at}.owner", f"{feature.get('owner')!r} is not a person")
        check.id(feature.get("agent"), f"{at}.agent")
        check.text(feature.get("title"), f"{at}.title")
        for key, allowed in (("vendor", VENDORS), ("role", ROLES), ("start", STARTS)):
            if feature.get(key) not in allowed:
                check.fail(f"{at}.{key}", f"must be one of {sorted(allowed)}")
        for scope_id in feature.get("area", []):
            if scope_id not in scopes:
                check.fail(f"{at}.area", f"{scope_id!r} is not a scope")
        if not feature.get("commits"):
            check.fail(f"{at}.commits", "must list at least one commit")
        previous = None
        tags: set[str] = set()
        for j, commit in enumerate(feature.get("commits", [])):
            spec = check_commit(
                commit, feature, f"{at}.commits[{j}]", people, scopes, check
            )
            if spec is None:
                continue
            if spec.after is not None and spec.after not in tags:
                check.fail(
                    f"{at}.commits[{j}].after",
                    f"{spec.after!r} is not the tag of an earlier commit",
                )
            if spec.tag is not None:
                tags.add(spec.tag)
            date = datetime.fromisoformat(spec.date)
            if previous is not None and date < previous:
                check.fail(
                    f"{at}.commits[{j}].date", "is earlier than the commit before"
                )
            previous = date
            commits.append(spec)
    return features, commits


def check_plan(raw: dict, features: dict, scopes: dict, check: Checker) -> None:
    for i, promotion in enumerate(raw.get("promotions", [])):
        if promotion.get("feature") not in features:
            check.fail(
                f"promotions[{i}].feature",
                f"{promotion.get('feature')!r} is not a feature",
            )
        check.date(promotion.get("date"), f"promotions[{i}].date")
    plan = raw.get("plan", {})
    if plan.get("feature") not in features:
        check.fail("plan.feature", f"{plan.get('feature')!r} is not a feature")
    for i, part in enumerate(plan.get("parts", [])):
        if part.get("scope") not in scopes:
            check.fail(
                f"plan.parts[{i}].scope", f"{part.get('scope')!r} is not a scope"
            )
        if part.get("kind") not in {"mechanical", "behavioural"}:
            check.fail(f"plan.parts[{i}].kind", "must be mechanical or behavioural")


def load_larder(raw: object) -> Larder:
    """Check the parsed larder.json and index it.

    Raises:
        LarderError: listing every problem found.
    """
    if not isinstance(raw, dict):
        raise LarderError(["the file must hold a JSON object"])
    check = Checker()
    people = check_people(raw, check)
    scopes, scope_paths = check_scopes(raw, people, check)
    check_invariants(raw, scope_paths, check)
    features, commits = check_features(raw, people, scopes, check)
    check_plan(raw, features, scopes, check)
    if check.problems:
        raise LarderError(check.problems)
    return Larder(raw, people, scopes, scope_paths, features, commits)


def read_larder(path: Path = LARDER) -> Larder:
    return load_larder(json.loads(path.read_text(encoding="utf-8")))


# The generated penguin/ files and examples files.


def owners_file(larder: Larder) -> dict:
    return {
        "$comment": "Owners of this repository, generated from larder.json by build.py. Format as in the other fixtures: 'id', 'display_name', 'delegate_owner_id' and 'role'.",
        "owners": [
            {
                "id": person["id"],
                "display_name": person["display_name"],
                "delegate_owner_id": None,
                "role": "owner",
            }
            for person in larder.people.values()
        ],
    }


def scopes_file(larder: Larder) -> dict:
    scopes = []
    for scope in larder.scopes.values():
        entry = {
            "id": scope["id"],
            "name": scope["name"],
            "owner": scope["owner"],
            "paths": scope["paths"],
            "contracts": scope.get("contracts", []),
            "test_command": f"python -m pytest {larder.scope_paths[scope['id']][0]}",
            "depends_on": [
                {"scope": provider, "kind": "imports"}
                for provider in scope.get("depends_on", [])
            ],
        }
        if scope.get("protected_paths"):
            entry["protected_paths"] = scope["protected_paths"]
        scopes.append(entry)
    return {
        "$comment": "Scope map of this repository, generated from larder.json by build.py. Format as in the other fixtures, plus 'contracts' (each scope's public symbols as path::symbol) and 'protected_paths' (files whose owner confirms the final lines of any change).",
        "scopes": scopes,
    }


def identities_file(larder: Larder) -> dict:
    identities = []
    for feature in larder.features.values():
        owner = feature["owner"]
        owned = [s["id"] for s in larder.scopes.values() if s["owner"] == owner]
        identities.append(
            {
                "handle": f"@{owner}/{feature['agent']}",
                "owner": owner,
                "vendor": feature["vendor"],
                "job": feature["title"],
                "charter_scopes": owned,
            }
        )
    return {
        "$comment": "Agent identities, one per feature, generated from larder.json by build.py. Format as in the other fixtures. Each identity's charter_scopes lists its owner's own scopes; a feature that declares a scope another person owns names it in its area in larder.json.",
        "identities": identities,
    }


def invariants_file(larder: Larder) -> dict:
    return {
        "$comment": "Each scope's declared invariants and recorded examples, generated from larder.json by build.py. Format in docs/design.md, Invariants and examples.",
        "invariants": larder.raw.get("invariants", []),
        "examples": [
            {"scope": e["scope"], "file": e["file"], "invariants": e["invariants"]}
            for e in larder.raw.get("examples", [])
        ],
    }


class Lcg:
    """A 64-bit linear congruential generator: the same draws on every machine and Python version."""

    def __init__(self, seed: int) -> None:
        self.state = seed

    def draw(self, bound: int) -> int:
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) % 2**64
        return (self.state >> 33) % bound


def sampled_orders(sample: dict) -> list[dict]:
    """The recorded orders of a sample spec, every draw kept: see the spec's $comment."""
    draw = Lcg(sample["seed"]).draw
    regions = sorted(sample["rates"])
    low, high = sample["price_cents"]
    orders = []
    for number in range(1, sample["orders"] + 1):
        count = 1 + draw(sample["max_lines"])
        region = regions[draw(len(regions))]
        lines = [
            (low + draw(high - low + 1), 1 + draw(sample["max_quantity"]))
            for _ in range(count)
        ]
        skus = [sample["skus"][draw(len(sample["skus"]))] for _ in range(count)]
        orders.append(
            {
                "id": f"order-{number:04d}",
                "region": region,
                "currency": sample["currency"],
                "lines": [
                    {"sku": sku, "quantity": quantity, "unit_price": cents / 100}
                    for sku, (cents, quantity) in zip(skus, lines, strict=True)
                ],
            }
        )
    return orders


def examples_file_text(example: dict) -> str:
    """An examples file: its contract and one case per line, in a fixed byte form."""
    if "sample" not in example:
        raise SystemExit(f"examples entry {example['file']} has no sample to generate")
    sample = example["sample"]
    cases = [
        {
            "name": record["id"],
            "args": {
                "order": {
                    "$call": sample["record_contract"],
                    "args": {"record": record},
                }
            },
        }
        for record in sampled_orders(sample)
    ]
    body = ",\n".join(json.dumps(case, sort_keys=True) for case in cases)
    head = json.dumps(
        {"$comment": sample["$comment"], "contract": example["contract"]},
        sort_keys=True,
    )[:-1]
    return f'{head}, "cases": [\n{body}\n]}}\n'


def json_text(value: dict) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


# Git.


def git_env() -> dict[str, str]:
    """An environment that isolates Git from the caller's configuration.

    Inherited GIT_* variables are dropped: GIT_DIR or GIT_INDEX_FILE from a surrounding hook would
    point Git at a repository outside TARGET. System and global config are ignored so a user's
    signing, autocrlf or template settings cannot change the hashed bytes.
    """
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def git(target: Path, *args: str, stdin: bytes | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(target), "-c", "core.autocrlf=false", *args],
        env=git_env(),
        input=stdin,
        check=True,
        capture_output=True,
    )
    return result.stdout.decode().strip()


def source_files(source: Path) -> dict[str, bytes]:
    """The files under ``source``, by path relative to it, with line endings normalised."""
    if not source.is_dir():
        raise SystemExit(f"missing fixture source directory: {source}")
    files = {}
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if SKIPPED_DIRS.intersection(relative.parts) or path.suffix in SKIPPED_SUFFIXES:
            continue
        if path.is_symlink():
            raise SystemExit(f"refusing symlink in fixture source: {path}")
        if not path.is_file():
            continue
        # A path goes into the import stream as text, so it may hold only plain segments.
        if not all(FILE_SEGMENT.fullmatch(part) for part in relative.parts):
            raise SystemExit(f"refusing unusual file name in fixture source: {path}")
        # CRLF is normalised so a checkout with line-ending conversion still hashes the same bytes.
        files[relative.as_posix()] = path.read_bytes().replace(b"\r\n", b"\n")
    return files


def prepare_target(target: Path) -> Path:
    if target.exists():
        if not target.is_dir():
            raise SystemExit(f"target is not a directory: {target}")
        if any(target.iterdir()):
            raise SystemExit(f"target directory is not empty: {target}")
    else:
        target.mkdir()
    return target.resolve()


def branch(feature_id: str) -> str:
    return f"feature-{feature_id}"


def raw_date(date: str) -> str:
    """An ISO date as fast-import's raw form: seconds since the epoch and the UTC offset."""
    parsed = datetime.fromisoformat(date)
    minutes = int(parsed.utcoffset().total_seconds()) // 60
    sign = "-" if minutes < 0 else "+"
    return f"{int(parsed.timestamp())} {sign}{abs(minutes) // 60:02d}{abs(minutes) % 60:02d}"


class ImportStream:
    """A ``git fast-import`` stream. Each commit names its parent and lays its files over the
    parent's tree; refs are set by ``reset``. One process writes every object, so a build is fast,
    and every hashed byte comes from this script."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.parents: dict[int, int | None] = {}

    def data(self, payload: bytes) -> None:
        self.chunks += [f"data {len(payload)}\n".encode(), payload, b"\n"]

    def commit(
        self,
        parent: int | None,
        person: tuple[str, str],
        date: str,
        message: str,
        files: dict[str, bytes],
    ) -> int:
        mark = len(self.parents) + 1
        self.parents[mark] = parent
        signature = f"{person[0]} <{person[1]}> {raw_date(date)}"
        self.chunks.append(
            f"commit refs/penguin/import\nmark :{mark}\n"
            f"author {signature}\ncommitter {signature}\n".encode()
        )
        self.data(message.encode())
        self.chunks.append(f"from :{parent}\n".encode() if parent else b"deleteall\n")
        for path, payload in sorted(files.items()):
            self.chunks.append(f"M 100644 inline {path}\n".encode())
            self.data(payload)
        self.chunks.append(b"\n")
        return mark

    def reset(self, ref: str, mark: int) -> None:
        self.chunks.append(f"reset {ref}\nfrom :{mark}\n\n".encode())

    def contains(self, mark: int, ancestor: int) -> bool:
        while mark is not None:
            if mark == ancestor:
                return True
            mark = self.parents[mark]
        return False

    def run(self, target: Path) -> dict[int, str]:
        """Feed the stream to Git in ``target`` and return each mark's commit SHA."""
        marks = target / ".git" / "penguin-import-marks"
        git(
            target,
            "fast-import",
            "--quiet",
            "--date-format=raw",
            f"--export-marks={marks}",
            stdin=b"".join(self.chunks),
        )
        # Commits are written on a scratch ref; only the branches and tags reset above remain.
        git(target, "update-ref", "-d", "refs/penguin/import")
        shas = {}
        for line in marks.read_text().splitlines():
            mark, sha = line.split()
            shas[int(mark.removeprefix(":"))] = sha
        marks.unlink()
        return shas


def author_of(larder: Larder, spec: CommitSpec) -> tuple[str, str]:
    if spec.author == "codemod":
        author = larder.raw["authors"]["codemod"]
        return author["name"], author["email"]
    person_id = (
        larder.features[spec.feature]["owner"]
        if spec.author == "owner"
        else spec.author
    )
    return larder.people[person_id]["display_name"], f"{person_id}@penguin.invalid"


def timeline(larder: Larder) -> list[CommitSpec | dict]:
    """Every commit and promotion in date order; equal dates keep larder.json's order."""
    events = [(spec.date, index, spec) for index, spec in enumerate(larder.commits)]
    events += [
        (promotion["date"], len(events) + index, promotion)
        for index, promotion in enumerate(larder.raw.get("promotions", []))
    ]
    events.sort(key=lambda event: (datetime.fromisoformat(event[0]), event[1]))
    return [event for _, _, event in events]


def penguin_files(larder: Larder) -> dict[str, bytes]:
    files = {
        "owners.json": owners_file(larder),
        "scopes.json": scopes_file(larder),
        "identities.json": identities_file(larder),
        "invariants.json": invariants_file(larder),
    }
    return {
        f"penguin/{name}": json_text(content).encode()
        for name, content in files.items()
    }


@dataclass(frozen=True)
class Built:
    """What a build made: every branch head and tag, and the SHA of each feature commit."""

    refs: dict[str, str]
    commits: list[tuple[CommitSpec, str]]


def build(target: Path, larder: Larder | None = None) -> Built:
    """Build the fixture repository in ``target``."""
    larder = larder or read_larder()
    target = prepare_target(target)
    git(target, "init", "--quiet", "--template=", "--initial-branch=main")
    stream = ImportStream()
    base = larder.raw["base"]
    files = {**source_files(HERE / base["source"]), **penguin_files(larder)}
    for example in larder.raw.get("examples", []):
        files[example["file"]] = examples_file_text(example).encode()
    fixture = larder.raw["authors"]["fixture"]
    base_mark = stream.commit(
        None, (fixture["name"], fixture["email"]), base["date"], base["message"], files
    )
    heads = {"main": base_mark}
    tags = {base["tag"]: base_mark}

    commits = []
    for event in timeline(larder):
        if isinstance(event, dict):
            name = branch(event["feature"])
            if not stream.contains(heads[name], heads["main"]):
                raise SystemExit(
                    f"{name} does not contain main, so main cannot move to it"
                )
            heads["main"] = heads[name]
            continue
        name = branch(event.feature)
        if name not in heads:
            from_main = larder.features[event.feature]["start"] == "main"
            heads[name] = heads["main"] if from_main else base_mark
        files = source_files(HERE / "features" / event.feature / event.source)
        parent = heads[name] if event.after is None else tags[f"{name}-{event.after}"]
        mark = stream.commit(
            parent, author_of(larder, event), event.date, event.message, files
        )
        if event.after is None:
            heads[name] = mark
        commits.append((event, mark))
        if event.tag is not None:
            tags[f"{name}-{event.tag}"] = mark

    for name, mark in heads.items():
        stream.reset(f"refs/heads/{name}", mark)
    for name, mark in tags.items():
        stream.reset(f"refs/tags/{name}", mark)
    shas = stream.run(target)
    git(target, "reset", "--quiet", "--hard", "main")
    refs = {name: shas[mark] for name, mark in {**heads, **tags}.items()}
    return Built(refs, [(spec, shas[mark]) for spec, mark in commits])


def pins_of(larder: Larder, built: Built) -> dict:
    """The pins of a build: branch heads, tags and the commit that fixes each test."""
    branches = {"main", *(branch(feature) for feature in larder.features)}

    def in_waves(spec: CommitSpec) -> bool:
        return spec.after is not None or larder.features[spec.feature]["role"] == "wave"

    def fixes_of(waves: bool) -> dict[str, str]:
        return {
            test: sha
            for spec, sha in built.commits
            if in_waves(spec) == waves
            for test in (spec.fix or {}).get("tests", [])
        }

    return {
        "$comment": "Commit SHAs a build of this fixture produces; `python build.py TARGET --pins` prints them. 'branches' maps main and each feature-<id> branch to its head. 'tags' maps base and each feature-<id>-<tag> tag to its commit. 'fixes' maps the pytest node ID of each test a fix commit of the one-block attempt makes pass to that commit; 'wave_fixes' does the same for the waves' fix commits. tests/test_money_fixture_builder.py checks a fresh build against this file.",
        "branches": {ref: built.refs[ref] for ref in sorted(branches)},
        "tags": {
            ref: sha for ref, sha in sorted(built.refs.items()) if ref not in branches
        },
        "fixes": dict(sorted(fixes_of(waves=False).items())),
        "wave_fixes": dict(sorted(fixes_of(waves=True).items())),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "target", type=Path, help="empty or missing directory to build into"
    )
    parser.add_argument("--pins", action="store_true", help="print the pins JSON")
    args = parser.parse_args(argv)
    try:
        larder = read_larder()
    except LarderError as error:
        print(error, file=sys.stderr)
        return 2
    built = build(args.target, larder)
    if args.pins:
        print(json.dumps(pins_of(larder, built), indent=2))
    else:
        for ref, sha in sorted(built.refs.items()):
            print(f"{ref} {sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
