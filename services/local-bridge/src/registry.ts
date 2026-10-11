import { createHash } from "node:crypto";

import { changedPaths, isObjectId, runGit } from "@penguin/git-analysis";

import { parseWorktreeList } from "./worktree-list.ts";

/**
 * A worktree as the bridge reports it, matching the PRD `Worktree` record. It carries a
 * `path_hash` in place of the absolute path, so it is safe to serialize and send to the cloud.
 */
export interface WorktreeRecord {
  id: string;
  bridge_id: string;
  owner_id: string;
  path_hash: string;
  branch: string | null;
  head_sha: string;
  baseline_sha: string;
  /** ISO 8601 time of the most recent refresh that listed this worktree. */
  last_seen: string;
}

export interface WorktreeRegistryOptions {
  /** Any path inside the repository; `git worktree list` reports every linked worktree. */
  repoPath: string;
  bridgeId: string;
  ownerId: string;
  now?: () => Date;
}

/**
 * Hashes a local path with the bridge ID, so the hash is stable for one bridge but cannot be
 * matched against a dictionary of common paths without knowing which bridge produced it.
 */
export function hashPath(bridgeId: string, path: string): string {
  return createHash("sha256").update(bridgeId).update("\0").update(path).digest("hex");
}

/** The registry ID of the worktree at `path` (absolute, as `git worktree list` reports it). */
export function worktreeId(bridgeId: string, path: string): string {
  return `wt_${hashPath(bridgeId, path).slice(0, 16)}`;
}

/**
 * The bridge's worktree registry, built from `git worktree list --porcelain`. Each worktree's
 * baseline is pinned to its HEAD when the registry first sees it and stays pinned across
 * refreshes until `pinBaseline` moves it.
 */
export class WorktreeRegistry {
  readonly #options: Required<WorktreeRegistryOptions>;
  // Absolute paths stay in memory only, keyed by worktree ID; records never carry them.
  readonly #paths = new Map<string, string>();
  readonly #records = new Map<string, WorktreeRecord>();

  constructor(options: WorktreeRegistryOptions) {
    this.#options = { now: () => new Date(), ...options };
  }

  /** Re-reads the worktree list. Worktrees no longer listed, bare or prunable are dropped. */
  async refresh(): Promise<WorktreeRecord[]> {
    const { repoPath, bridgeId, ownerId, now } = this.#options;
    const output = await runGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
    const seenAt = now().toISOString();
    const seen = new Set<string>();
    for (const entry of parseWorktreeList(output)) {
      if (entry.bare || entry.prunable || entry.headSha === null) continue;
      const pathHash = hashPath(bridgeId, entry.path);
      const id = worktreeId(bridgeId, entry.path);
      seen.add(id);
      this.#paths.set(id, entry.path);
      this.#records.set(id, {
        id,
        bridge_id: bridgeId,
        owner_id: ownerId,
        path_hash: pathHash,
        branch: entry.branch,
        head_sha: entry.headSha,
        baseline_sha: this.#records.get(id)?.baseline_sha ?? entry.headSha,
        last_seen: seenAt,
      });
    }
    for (const id of this.#records.keys()) {
      if (!seen.has(id)) {
        this.#records.delete(id);
        this.#paths.delete(id);
      }
    }
    return this.list();
  }

  list(): WorktreeRecord[] {
    return [...this.#records.values()].map((record) => ({ ...record }));
  }

  get(id: string): WorktreeRecord | undefined {
    const record = this.#records.get(id);
    return record && { ...record };
  }

  /** Pins a worktree's baseline to a commit that exists in the repository. */
  async pinBaseline(id: string, baselineSha: string): Promise<WorktreeRecord> {
    const record = this.#require(id);
    if (!isObjectId(baselineSha)) {
      throw new Error(`baseline must be a full object ID, got ${JSON.stringify(baselineSha)}`);
    }
    await runGit(this.#pathOf(id), [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${baselineSha}^{commit}`,
    ]);
    record.baseline_sha = baselineSha;
    return { ...record };
  }

  /** Tracked paths changed in the worktree since its pinned baseline. */
  async changedPaths(id: string): Promise<string[]> {
    return changedPaths(this.#require(id).baseline_sha, this.#pathOf(id));
  }

  /** The worktree's absolute path, for in-process Git calls only; never serialize it. */
  pathOf(id: string): string {
    this.#require(id);
    return this.#pathOf(id);
  }

  /** The registry as JSON: worktree records with path hashes and no absolute paths. */
  serialize(): string {
    return JSON.stringify(this.list());
  }

  #require(id: string): WorktreeRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`unknown worktree ${id}`);
    return record;
  }

  #pathOf(id: string): string {
    const path = this.#paths.get(id);
    if (path === undefined) throw new Error(`unknown worktree ${id}`);
    return path;
  }
}
