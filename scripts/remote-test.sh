#!/usr/bin/env bash
# Runs a test tier of the current checkout on the test machine instead of this one.
#
#   scripts/remote-test.sh [copy|fast|slow|all|pytest|pytest-fast|typecheck] [more tiers...]
#
# The checkout (a worktree or main) is copied to the test machine under its own directory, so
# parallel worktrees never share files. Dependencies are installed there once per lockfile: a copy
# whose lockfiles match the main copy links the main copy's node_modules and .venv. The machine needs
# no GitHub or Cloudflare credentials; live tests skip without their flags.
#
# PENGUIN_TEST_HOST overrides the machine (default springbuilt@gn100-767e over Tailscale).
set -euo pipefail

HOST="${PENGUIN_TEST_HOST:-springbuilt@gn100-767e}"
ROOT="$(git rev-parse --show-toplevel)"
NAME="$(basename "$ROOT")"
[ "$NAME" = "penguin" ] && NAME="main"
DIR="penguin-ci/$NAME"
TIERS=("${@:-fast}")

rsync -az --delete \
  --exclude node_modules --exclude .venv --exclude .claude/ --exclude docs/progress/ \
  --exclude __pycache__ --exclude .wrangler --exclude .pytest_cache \
  "$ROOT/" "$HOST:$DIR/"

ssh "$HOST" bash -s -- "$DIR" "${TIERS[@]}" <<'REMOTE'
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
dir="$1"; shift
cd "$HOME/$dir"
main="$HOME/penguin-ci/main"
same() { [ "$dir" != "penguin-ci/main" ] && cmp -s "$1" "$main/$1"; }
if same package-lock.json && [ -d "$main/node_modules" ]; then
  # Link main's installed packages; the workspace packages resolve to this checkout, not main's.
  if [ ! -d node_modules ]; then
    mkdir node_modules
    for entry in "$main"/node_modules/* "$main"/node_modules/.bin; do
      base="$(basename "$entry")"
      [ "$base" = "@penguin" ] || ln -s "$entry" "node_modules/$base"
    done
    mkdir node_modules/@penguin
    for pkg in apps/* services/* packages/*; do
      [ -f "$pkg/package.json" ] || continue
      ln -s "$PWD/$pkg" "node_modules/$(node -p "require('./$pkg/package.json').name")"
    done
  fi
elif [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm ci --no-audit --no-fund >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }
fi
if same uv.lock && [ -d "$main/.venv" ]; then [ -e .venv ] || ln -s "$main/.venv" .venv
else uv sync -q || { echo "uv sync failed"; exit 1; }; fi
status=0
for tier in "$@"; do
  start=$(date +%s)
  case "$tier" in
    copy|fast|slow|all) node scripts/test.mjs "$tier" > ".test-$tier.log" 2>&1 ;;
    pytest) uv run --no-sync pytest -q > ".test-$tier.log" 2>&1 ;;
    pytest-fast) uv run --no-sync pytest -m "not slow" -q > ".test-$tier.log" 2>&1 ;;
    typecheck) npm run typecheck > ".test-$tier.log" 2>&1 ;;
    *) echo "unknown tier $tier"; exit 2 ;;
  esac
  code=$?
  [ $code -eq 0 ] || status=$code
  summary="$(grep -E '^# (pass|fail) |^(ℹ (pass|fail))|passed|failed' ".test-$tier.log" | tail -3 | tr '\n' ' ')"
  echo "$tier: exit $code in $(( $(date +%s) - start ))s ${summary}"
  [ $code -eq 0 ] || grep -E '^not ok|✖|FAILED|error TS' ".test-$tier.log" | head -20
done
exit $status
REMOTE
