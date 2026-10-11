import { splitNul } from "@penguin/git-analysis";

/** One record from `git worktree list --porcelain -z`. */
export interface WorktreeListEntry {
  path: string;
  headSha: string | null;
  /** Short branch name, or null for a detached HEAD or a bare repository. */
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

/**
 * Parses `git worktree list --porcelain -z`: each attribute is NUL-terminated and an empty
 * field ends a record. `-z` keeps paths with newlines or quotes intact.
 */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const field of splitNul(output)) {
    if (field === "") {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, headSha: null, branch: null, bare: false, prunable: false };
    } else if (current && key === "HEAD") {
      current.headSha = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "bare") {
      current.bare = true;
    } else if (current && key === "prunable") {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}
