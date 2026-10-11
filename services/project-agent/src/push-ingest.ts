// Finds the operation files that pushes to the issues repo added and applies them in coordination
// order (packages/protocol/src/order.ts).
//
// A push event names commit IDs but no changed files, and the Artifacts binding has no diff. So the
// walk lists the first-parent chain from the pushed head back to the newest commit already ingested,
// then compares each commit's `issues/` tree with its first parent's, one tree level at a time,
// skipping every subtree whose hash did not change.
//
// The walk stops at the newest ingested commit, not at the event's `before`. Queue delivery order is
// not push order: if the second of two pushes is processed first, walking back to its `before` would
// skip the first push's commits and apply the later operations ahead of the ones they build on.
// Walking back to the last ingested commit picks those commits up in order, and makes the first
// push's event a no-op when it arrives. It also makes `commitsTruncated` irrelevant, since the
// commit list in the event is never read.

import { coordinationOrder, readBaseVersion, type OperationFileRef } from "@penguin/protocol";

import type { SqlDatabase } from "./issue-index.ts";

/** The subset of `ArtifactsCommitMetadata` the walk reads. */
export interface RepoCommit {
  readonly hash: string;
  readonly treeHash: string;
}

/** The subset of `ArtifactsTreeEntry` the walk reads. */
export interface RepoTreeEntry {
  readonly name: string;
  readonly hash: string;
  readonly type: string;
}

/** The subset of the binding's `ArtifactsRepo` capability the walk calls. */
export interface IssuesRepoReader {
  log(opts: { ref: string; limit: number; offset: number }): Promise<readonly RepoCommit[]>;
  readTree(hash: string): Promise<readonly RepoTreeEntry[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
}

/** One operation file a commit added, with its bytes. */
export interface AddedOperationFile extends OperationFileRef {
  readonly bytes: Uint8Array;
}

/** Applies one operation file read from the issues repo. Must throw if the result was not committed. */
export type ApplyFile = (file: AddedOperationFile, commit: string) => Promise<{ readonly status: string }>;

export interface IngestReport {
  /** First-parent commits walked that had not been ingested before. */
  readonly commits: number;
  /** Operation files those commits added, each applied once. */
  readonly files: number;
  /** Counts of apply outcomes by status: applied, rejected or duplicate. */
  readonly outcomes: Readonly<Record<string, number>>;
  /** Calls made through the binding, by method name. */
  readonly bindingCalls: Readonly<Record<string, number>>;
}

/** `log()` returns at most 1000 commits per call. */
const LOG_PAGE = 1000;

export const INGEST_LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS IngestedCommit (sha TEXT PRIMARY KEY, ingested_at INTEGER NOT NULL)`;

/** The issues-repo commits whose added operation files have all been applied. */
export class IngestLedger {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    db.exec(INGEST_LEDGER_SCHEMA);
  }

  has(sha: string): boolean {
    return this.#db.exec(`SELECT 1 FROM IngestedCommit WHERE sha = ?`, sha).length > 0;
  }

  add(sha: string, now: number): void {
    this.#db.exec(`INSERT OR IGNORE INTO IngestedCommit (sha, ingested_at) VALUES (?, ?)`, sha, now);
  }
}

/**
 * Applies every operation file added on the first-parent chain ending at `head` that the ledger has
 * not seen, oldest commit first. A commit enters the ledger only after all its files are applied, so
 * a crash part way through repeats that commit, and the index's op_id check absorbs the repeats.
 *
 * Throws when `head` cannot be resolved or a Git object is missing, so the caller can retry.
 */
export async function ingestPush(
  repo: IssuesRepoReader,
  head: string,
  ledger: IngestLedger,
  apply: ApplyFile,
  now: () => number = Date.now,
): Promise<IngestReport> {
  const counted = countCalls(repo);
  const { commits, baseTree } = await newCommits(counted.repo, head, ledger);
  const trees = new TreeCache(counted.repo);
  const outcomes: Record<string, number> = {};
  let files = 0;

  let parentTree = baseTree;
  for (const commit of commits) {
    const added = await addedOperationFiles(counted.repo, trees, parentTree, commit.treeHash);
    for (const { file } of coordinationOrder([{ sha: commit.hash, files: added }])) {
      const outcome = await apply(file, commit.hash);
      outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
      files += 1;
    }
    ledger.add(commit.hash, now());
    parentTree = commit.treeHash;
  }
  return { commits: commits.length, files, outcomes, bindingCalls: { ...counted.calls } };
}

/**
 * The first-parent commits from `head` back to, but not including, the newest ingested commit,
 * oldest first, and the tree of the commit the walk stopped at (undefined at the root).
 */
async function newCommits(
  repo: IssuesRepoReader,
  head: string,
  ledger: IngestLedger,
): Promise<{ commits: RepoCommit[]; baseTree: string | undefined }> {
  const commits: RepoCommit[] = [];
  for (let offset = 0; ; offset += LOG_PAGE) {
    const page = await repo.log({ ref: head, limit: LOG_PAGE, offset });
    if (offset === 0 && page.length === 0) throw new Error(`issues repo commit ${head} not found`);
    for (const commit of page) {
      if (ledger.has(commit.hash)) return { commits: commits.reverse(), baseTree: commit.treeHash };
      commits.push(commit);
    }
    if (page.length < LOG_PAGE) return { commits: commits.reverse(), baseTree: undefined };
  }
}

/** Reads each tree once per ingest; consecutive commits share most of their trees. */
class TreeCache {
  readonly #repo: IssuesRepoReader;
  readonly #trees = new Map<string, Promise<ReadonlyMap<string, RepoTreeEntry>>>();

  constructor(repo: IssuesRepoReader) {
    this.#repo = repo;
  }

  /** The tree's entries by name; an absent hash reads as an empty tree. */
  read(hash: string | undefined): Promise<ReadonlyMap<string, RepoTreeEntry>> {
    if (hash === undefined) return Promise.resolve(new Map());
    let tree = this.#trees.get(hash);
    if (tree === undefined) {
      tree = this.#repo.readTree(hash).then((entries) => {
        if (entries === null) throw new Error(`issues repo tree ${hash} not found`);
        return new Map(entries.map((entry) => [entry.name, entry]));
      });
      this.#trees.set(hash, tree);
    }
    return tree;
  }

  /** The hash of the subtree `name` in `hash`, or undefined when there is none. */
  async subtree(hash: string | undefined, name: string): Promise<string | undefined> {
    const entry = (await this.read(hash)).get(name);
    return entry?.type === "tree" ? entry.hash : undefined;
  }
}

/** Blob entries are regular files; `exec` is a regular file with the executable bit. */
function isFile(entry: RepoTreeEntry): boolean {
  return entry.type === "blob" || entry.type === "exec";
}

/**
 * The files under `issues/<id>/ops/` in `tree` whose names are absent from `parentTree`. Operation
 * files are never edited, so a file present in both is not new, whatever its contents.
 */
async function addedOperationFiles(
  repo: IssuesRepoReader,
  trees: TreeCache,
  parentTree: string | undefined,
  tree: string,
): Promise<AddedOperationFile[]> {
  const issues = await trees.subtree(tree, "issues");
  const parentIssues = await trees.subtree(parentTree, "issues");
  if (issues === undefined || issues === parentIssues) return [];

  const parentDirs = await trees.read(parentIssues);
  const added: AddedOperationFile[] = [];
  for (const dir of (await trees.read(issues)).values()) {
    if (dir.type !== "tree") continue;
    const parentDir = parentDirs.get(dir.name);
    if (parentDir?.hash === dir.hash) continue;
    const ops = await trees.subtree(dir.hash, "ops");
    const parentOps = parentDir?.type === "tree" ? await trees.subtree(parentDir.hash, "ops") : undefined;
    if (ops === undefined || ops === parentOps) continue;

    const parentFiles = await trees.read(parentOps);
    for (const entry of (await trees.read(ops)).values()) {
      if (!isFile(entry) || parentFiles.has(entry.name)) continue;
      const blob = await repo.readBlob(entry.hash);
      if (blob === null) throw new Error(`issues repo blob ${entry.hash} not found`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      added.push({ path: `issues/${dir.name}/ops/${entry.name}`, baseVersion: readBaseVersion(bytes), bytes });
    }
  }
  return added;
}

/** Wraps `repo` so each binding call is counted by method name. */
export function countCalls(repo: IssuesRepoReader): { repo: IssuesRepoReader; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (method: string): void => {
    calls[method] = (calls[method] ?? 0) + 1;
  };
  return {
    calls,
    repo: {
      log: (opts) => (count("log"), repo.log(opts)),
      readTree: (hash) => (count("readTree"), repo.readTree(hash)),
      readBlob: (hash) => (count("readBlob"), repo.readBlob(hash)),
    },
  };
}
