#!/usr/bin/env bash
# Prints one line per agent worktree: commits ahead of origin/main, files changed in the last 30
# minutes, live processes and the newest commit. The coordinator reads it to spot a stalled agent.
cd "$(git rev-parse --show-toplevel)" || exit 1
git fetch -q origin
for w in .claude/worktrees/agent-*; do
  [ -d "$w" ] || continue
  id=${w##*agent-}
  ahead=$(git -C "$w" log --oneline origin/main..HEAD 2>/dev/null | wc -l | tr -d ' ')
  recent=$(find "$w" -path '*/node_modules' -prune -o -path '*/.venv' -prune -o -type f -newermt '-30 minutes' -print 2>/dev/null | wc -l | tr -d ' ')
  procs=$(ps -axww -o command | grep -c "agent-$id" | awk '{print $1-1}')
  last=$(git -C "$w" log -1 --format='%cr: %s' 2>/dev/null | cut -c1-70)
  echo "$id ahead=$ahead files_30min=$recent procs=$procs | $last"
done
