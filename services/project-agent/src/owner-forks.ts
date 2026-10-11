// The owner forks' latest checkpoints (PRD section 7, `OwnerFork`). Checkpoints in owner forks reach
// Penguin through a report rather than a push subscription (PRD section 5), so a new fork needs no
// new subscription. An agent session reports through the MCP `report_checkpoint` tool; the owner's
// bridge reports through its checkpoint route after each push. A report is recorded only after the
// commit is confirmed to exist in the reporting owner's own fork.
//
// The table holds the fields a report sets. `project_id` is implied by the ProjectAgent, which serves
// one project, and `publishing_consent` stays with the owner's bridge, which asks before each publish.

import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import type { SessionRejection, SessionStore, ThreadRef } from "./session-store.ts";

type Row = Record<string, SqlValue>;

export const OWNER_FORK_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS OwnerFork (
    owner_id TEXT PRIMARY KEY, artifacts_repo TEXT NOT NULL, latest_checkpoint_sha TEXT,
    reported_by_session TEXT, reported_at INTEGER)`,
];

/** A full, lowercase Git SHA-1, the form the Artifacts binding's `readCommit` takes. */
export const CHECKPOINT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export interface OwnerFork {
  readonly ownerId: string;
  /** The fork's Artifacts repo name, with the deployment's repo prefix. */
  readonly artifactsRepo: string;
  readonly latestCheckpointSha: string | null;
  /** The agent session that reported the latest checkpoint, or null when the owner's bridge did. */
  readonly reportedBySession: string | null;
  /** When the latest checkpoint was reported, as an ISO 8601 time, or null. */
  readonly reportedAt: string | null;
}

export type CheckpointOutcome = { readonly status: "ok"; readonly fork: OwnerFork } | SessionRejection;

/**
 * A checkpoint a session reported, with the fix tasks it delivered to that session and the threads
 * needing the session's owner that the session hears of for the first time.
 */
export type SessionCheckpointOutcome =
  | {
      readonly status: "ok";
      readonly fork: OwnerFork;
      readonly delivered: readonly string[];
      readonly threads: readonly ThreadRef[];
    }
  | SessionRejection;

export class OwnerForkStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of OWNER_FORK_SCHEMA) db.exec(statement);
  }

  get(ownerId: string): OwnerFork | undefined {
    const [row] = this.#db.exec(`SELECT * FROM OwnerFork WHERE owner_id = ?`, ownerId);
    return row === undefined ? undefined : ownerFork(row);
  }

  /** Every owner's fork, in owner order. */
  list(): OwnerFork[] {
    return this.#db.exec(`SELECT * FROM OwnerFork ORDER BY owner_id`).map(ownerFork);
  }

  /** Records `sha` as the owner's latest checkpoint in `artifactsRepo`. */
  recordCheckpoint(ownerId: string, artifactsRepo: string, sha: string, sessionId: string | null): OwnerFork {
    this.#db.exec(
      `INSERT INTO OwnerFork (owner_id, artifacts_repo, latest_checkpoint_sha, reported_by_session, reported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_id) DO UPDATE SET artifacts_repo = excluded.artifacts_repo,
         latest_checkpoint_sha = excluded.latest_checkpoint_sha,
         reported_by_session = excluded.reported_by_session, reported_at = excluded.reported_at`,
      ownerId,
      artifactsRepo,
      sha,
      sessionId,
      this.#now(),
    );
    return this.get(ownerId) as OwnerFork;
  }
}

export interface CheckpointRecordDeps {
  readonly forks: OwnerForkStore;
  /** True when the commit exists in `artifactsRepo` (the binding's `readCommit` returns it). */
  readonly commitExists: (artifactsRepo: string, sha: string) => Promise<boolean>;
}

export interface CheckpointDeps extends CheckpointRecordDeps {
  readonly sessions: Pick<SessionStore, "heartbeat" | "checkpoint">;
}

/**
 * Records a checkpoint `caller` reports from session `sessionId`. `artifactsRepo` is the caller's own
 * fork, named by the Worker from the authenticated owner, never from the report. The call counts as
 * the session's heartbeat. A recorded checkpoint is an explicit safe checkpoint of the session, so
 * the fix tasks waiting for it are delivered.
 */
export async function reportCheckpoint(
  deps: CheckpointDeps,
  caller: string,
  sessionId: string,
  sha: string,
  artifactsRepo: string,
): Promise<SessionCheckpointOutcome> {
  const live = deps.sessions.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const recorded = await recordReportedCheckpoint(deps, caller, sha, artifactsRepo, sessionId);
  if (recorded.status === "rejected") return recorded;
  // The session can have gone offline while the commit was looked up; it then receives nothing.
  const delivery = deps.sessions.checkpoint(caller, sessionId);
  if (delivery.status !== "ok") return { ...recorded, delivered: [], threads: [] };
  return { ...recorded, delivered: delivery.delivered, threads: delivery.threads };
}

/**
 * Records a checkpoint reported for `owner`'s fork `artifactsRepo` once the commit is found there.
 * `sessionId` names the reporting agent session, or is null for a report from the owner's bridge,
 * which runs no session. The caller authenticates `owner` and names `artifactsRepo` from it.
 */
export async function recordReportedCheckpoint(
  deps: CheckpointRecordDeps,
  owner: string,
  sha: string,
  artifactsRepo: string,
  sessionId: string | null,
): Promise<CheckpointOutcome> {
  if (typeof sha !== "string" || !CHECKPOINT_SHA_PATTERN.test(sha)) {
    return { status: "rejected", reason: "invalid", message: "the checkpoint must be a full 40-character lowercase SHA" };
  }
  if (!(await deps.commitExists(artifactsRepo, sha))) {
    return { status: "rejected", reason: "not_found", message: `commit ${sha} is not in ${owner}'s fork` };
  }
  return { status: "ok", fork: deps.forks.recordCheckpoint(owner, artifactsRepo, sha, sessionId) };
}

function ownerFork(row: Row): OwnerFork {
  const reportedAt = row["reported_at"];
  return {
    ownerId: row["owner_id"] as string,
    artifactsRepo: row["artifacts_repo"] as string,
    latestCheckpointSha: (row["latest_checkpoint_sha"] as string | null) ?? null,
    reportedBySession: (row["reported_by_session"] as string | null) ?? null,
    reportedAt: reportedAt === null || reportedAt === undefined ? null : new Date(Number(reportedAt)).toISOString(),
  };
}
