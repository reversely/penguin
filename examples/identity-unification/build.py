"""Build the pinned identity-unification fixture repository.

Usage: python build.py TARGET

TARGET must be an empty directory or a path that does not exist yet. The builder creates a Git
repository there and commits each entry of ``COMMITS`` in order. Each commit's tree is the files
under its ``source`` directory next to this script. Every value Git hashes is fixed here (author,
committer, dates, message, file bytes and modes), so every machine gets the same commit SHAs.

The builder runs only local Git commands, makes no network request and writes only inside TARGET.
"""

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Files a local test run leaves in a source directory; they never belong in a commit.
SKIPPED_DIRS = frozenset({"__pycache__", ".pytest_cache"})
SKIPPED_SUFFIXES = frozenset({".pyc", ".pyo"})

FIXTURE_AUTHOR = ("Penguin Fixture", "fixture@penguin.invalid")


@dataclass(frozen=True)
class Commit:
    branch: str
    source: str
    message: str
    author: tuple[str, str]
    date: str


# Later fixture commits (owner checkpoints and fixes) append entries here.
COMMITS = (
    Commit(
        branch="main",
        source="base",
        message=(
            "Base: identity map, analytics models and messaging\n\n"
            "Three scopes owned by priya, jun and sam, declared in penguin/scopes.json.\n"
        ),
        author=FIXTURE_AUTHOR,
        date="2026-01-05T09:00:00+00:00",
    ),
)


def git_env(commit: Commit | None = None) -> dict[str, str]:
    """Return an environment that isolates Git from the caller's configuration.

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
    if commit is not None:
        name, email = commit.author
        for role in ("AUTHOR", "COMMITTER"):
            env[f"GIT_{role}_NAME"] = name
            env[f"GIT_{role}_EMAIL"] = email
            env[f"GIT_{role}_DATE"] = commit.date
    return env


def git(target: Path, *args: str, commit: Commit | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(target), "-c", "core.autocrlf=false", *args],
        env=git_env(commit),
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def source_files(source: Path) -> list[Path]:
    """List the files under ``source`` in a fixed order, relative to it."""
    files = []
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if SKIPPED_DIRS.intersection(relative.parts) or path.suffix in SKIPPED_SUFFIXES:
            continue
        if path.is_symlink():
            raise SystemExit(f"refusing symlink in fixture source: {path}")
        if path.is_file():
            files.append(relative)
    return files


def copy_tree(source: Path, target: Path) -> None:
    for relative in source_files(source):
        destination = (target / relative).resolve()
        if not destination.is_relative_to(target):
            raise SystemExit(f"refusing to write outside the target: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Normalise line endings so a checkout with CRLF conversion still hashes the same bytes.
        destination.write_bytes(
            (source / relative).read_bytes().replace(b"\r\n", b"\n")
        )
        destination.chmod(0o644)


def prepare_target(target: Path) -> Path:
    if target.exists():
        if not target.is_dir():
            raise SystemExit(f"target is not a directory: {target}")
        if any(target.iterdir()):
            raise SystemExit(f"target directory is not empty: {target}")
    else:
        target.mkdir()
    return target.resolve()


def build(target: Path) -> dict[str, str]:
    """Build the fixture repository in ``target`` and return each branch's head SHA."""
    target = prepare_target(target)
    git(
        target,
        "init",
        "--quiet",
        "--template=",
        f"--initial-branch={COMMITS[0].branch}",
    )
    heads = {}
    for commit in COMMITS:
        copy_tree(HERE / commit.source, target)
        git(target, "add", "--all")
        git(
            target,
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            commit.message,
            commit=commit,
        )
        heads[commit.branch] = git(target, "rev-parse", "HEAD")
    return heads


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "target", type=Path, help="empty or missing directory to build into"
    )
    args = parser.parse_args(argv)
    for branch, sha in build(args.target).items():
        print(f"{branch} {sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
