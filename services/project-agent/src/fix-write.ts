// Writing approved fixes into affected features' forks (PRD 0.4 section 4.4 step 1, section 8 Security,
// section 9 `FixWrite`).
//
// Once an author approves a part of a merge plan on their running feature, the part's patch is written
// into that feature's existing fork as one commit on `main`. No branch or fork is made.
//
// - Who writes. A behavioural part is written by the originating agent named in the plan
//   (`Plan.proposedBy`): a session of that identity on the originating feature asks `fix_token` and gets
//   a write token on the affected fork alone. A mechanical part, Penguin's codemod, is written by the
//   check runner: its approval queues a write. The runner's claim gets a token minted for that part
//   only. The identity a behavioural part's edit task was routed to (edit-tasks.ts, PRD 0.5 section
//   4.4a: the target feature's builder first) may write it too: its session through `fix_token`, or
//   its person's bridge through the task's claim. No other session, identity or bridge gets a token
//   on another person's fork here.
// - When. Only for the current revision of a part in the feature's newest plan, only while it is
//   approved and not yet written. Anything else is refused and no token is minted. The Worker mints the
//   token for minutes (PENGUIN_FIX_TOKEN_TTL_MINUTES); its plaintext never reaches this module.
// - Paths. Before any token, the patch is parsed again and every file it writes must lie inside the
//   part's scopes and in the part's approved diff. A patch touching another path is refused.
// - The fork head. The commit must fast-forward the fork head. When the head is still the patch's base,
//   that is the parent. When the author's own agent moved the head, Penguin checks the patch against the
//   new head: if every hunk still applies at its line, the head is the parent (a clean rebase); if not,
//   the part goes back to the originating agent with Penguin's request to revise it against the new
//   head. Its author approves the revision again.
// - One write per fork at a time (#133, design.md Build step 4). Every approved part on a running feature
//   opens its write at approval, so the writes into one fork stand in approval order. A write is
//   granted only when no other write into that fork holds a token, no write approved earlier still
//   waits there, and, after another write landed in the fork, the part's trial on the new head passed
//   (fix-retrial.ts). Anything else is refused as `waiting` with what it waits for; no token is minted.
//   A migration edit task's run into a fork takes a place in the same order (`task` writes,
//   edit-work.ts): its claim waits while another write holds the fork.
// - The record. The writer reports the commit. Penguin reads it through the Artifacts binding and keeps
//   it only when its one parent is the granted head, its message is the one built from the part's
//   validated fields (fixCommitMessage), it changes exactly the patch's files and each file is the
//   patch applied to the parent. The commit must also be on the fork's `main`. A kept write is a signed `fix_write` record
//   and a `FixWrite` row in the feature's plan store; a refused one is a signed `fix_write_refused`
//   record.
// - Migration parts. An approved rule-written part of a split's migration plan (migration-plans.ts,
//   PRD 0.5 section 4.2 step 2) is written by the check runner the same way, into its running
//   feature's fork or into the plan's block feature for code on main, with the same token scope and
//   the same commit check. Its grant names its migration plan; `MigrationWrites` answers the part, and
//   a kept write makes it `written` there in place of a FixWrite row. A target fork whose head no
//   longer takes the patch makes the part an edit task. A target whose start waits on an overlap lock
//   gets no write until the lock is approved.
// - Copy writes (#179). The check runner's write of a mechanical or verify part copies the originating
//   change's modules the fork imports (module-copy.ts). A copy write does the same for any approved
//   part on a running feature, behavioural ones included, with no patch: it is keyed
//   `copy:<revision>:<part id>` and opened at each approval for the originating change's current
//   revision, and by a land whose affected forks do not hold that revision's modules. A copy write of a
//   revision the originating change has moved past is withdrawn. A fork that changed a copied module
//   itself sends the part back to the originating agent with the fork's lines (`copy_conflict`).

import {
  applyPatchFile,
  FIX_WRITE_BRANCH,
  fixCommitMessage,
  isMigrationPlanId,
  parsePatch,
  RUNNER_WRITER,
  type FixWriter,
  type FixWriteSpec,
  type ModuleCopy,
  type Plan,
  type PlanFileDiff,
  type PlanPart,
} from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRejectReason } from "./feature-open.ts";
import { parseFeatureId, readOnlyReason, type Feature, type FeatureRecord, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
import type { PlanRouteStore } from "./plan-approval.ts";
import type { FixWrite, PlanKeeper } from "./plan-store.ts";
import { readCopy, type CopyReading } from "./module-copy.ts";
import { newestRevision } from "./part-trial.ts";
import { changedFiles, readFileText, type GitObjectReader } from "./repo-diff.ts";
import { notStopped, RUN_FAILURE_SCHEMA, type StoreRelease } from "./run-failures.ts";
import type { SessionOutcome } from "./session-store.ts";

type Row = Record<string, SqlValue>;

/** How long a runner's claim of a write holds before another claim may take it. */
export const FIX_WRITE_LEASE_MS = 10 * 60_000;

/**
 * How long a granted write holds its fork: the lifetime of the token the Worker mints for it,
 * PENGUIN_FIX_TOKEN_TTL_MINUTES read as apps/worker/src/tokens.ts reads it (1 to 60 minutes, 10 when
 * unset). A value the Worker refuses mints no token, so the default lease stands.
 */
export function parseFixTokenLease(minutes: string | undefined): number {
  if (minutes === undefined || !/^[1-9][0-9]?$/u.test(minutes) || Number(minutes) > 60) return FIX_WRITE_LEASE_MS;
  return Number(minutes) * 60_000;
}

/** How far back from the fork's head a reported commit is looked for on `main`. */
const HEAD_SEARCH_LIMIT = 50;

export const FIX_GRANT_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS FixWriteGrant (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, plan_id TEXT NOT NULL, part_id TEXT NOT NULL,
    revision INTEGER NOT NULL, target_feature_id TEXT NOT NULL, writer TEXT NOT NULL, state TEXT NOT NULL,
    parent TEXT, rebased INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, lease_until INTEGER, commit_sha TEXT,
    record_id TEXT, created_at INTEGER NOT NULL, granted_at INTEGER, written_at INTEGER, UNIQUE (part_id, revision))`,
  `CREATE INDEX IF NOT EXISTS FixWriteGrant_writer ON FixWriteGrant (writer, state)`,
];

/**
 * Columns added since the table was first deployed: the fork head another plan's write left, which the
 * part must be tried on before its own write (`retrial_head`), that trial's id, and the head its last
 * passing re-trial ran on.
 */
const GRANT_COLUMNS: readonly (readonly [string, string])[] = [
  ["retrial_head", "retrial_head TEXT"],
  ["retrial_trial", "retrial_trial INTEGER"],
  ["trialled_head", "trialled_head TEXT"],
  ["copies", "copies TEXT"],
];

/** The states in which a write still waits to be made: it holds the fork's order. */
const OPEN_STATES = "('queued', 'granted')";

/**
 * Who makes a write: the originating agent or a fix task's holder (`agent`), the check runner
 * (`runner`), or a migration edit task's run (`task`, keyed `task:<id>`), which commits its own change.
 */
export type GrantWriter = FixWriter | "task";

/** The part id a migration edit task's write is kept under. */
export const taskWriteKey = (taskId: number): string => `task:${taskId}`;

const COPY_KEY = /^copy:([0-9a-f]{40}):(.+)$/u;

/** The key a copy write of plan part `partId` is kept under, for the originating change's revision `source`. */
export const copyWriteKey = (partId: string, source: string): string => `copy:${source}:${partId}`;

/** The part and the originating revision a copy write names, or undefined for any other write. */
export function copyWriteOf(grant: Pick<FixGrant, "partId">): { readonly partId: string; readonly source: string } | undefined {
  const match = COPY_KEY.exec(grant.partId);
  return match === null ? undefined : { source: match[1] as string, partId: match[2] as string };
}

/** The plan part a write writes: a copy write's part, or the write's own key. */
export const writtenPart = (grant: Pick<FixGrant, "partId">): string => copyWriteOf(grant)?.partId ?? grant.partId;

/**
 * Where one revision's write stands. `queued`: a mechanical part waits for the runner to claim it.
 * `granted`: a writer holds a token and Penguin waits for its commit. `written`: the commit is kept.
 * `withdrawn`: the part moved on before it was written (a new revision, a decision or a moved head).
 */
export type FixGrantState = "queued" | "granted" | "written" | "withdrawn";

export interface FixGrant {
  readonly id: number;
  readonly featureId: string;
  readonly planId: string;
  readonly partId: string;
  readonly revision: number;
  readonly targetFeatureId: string;
  readonly writer: GrantWriter;
  readonly state: FixGrantState;
  readonly parent: string | null;
  readonly rebased: boolean;
  /** The runner bridge holding the claim, or null. */
  readonly claimedBy: string | null;
  readonly leaseUntil: number | null;
  readonly commitSha: string | null;
  readonly recordId: string | null;
  /** When the write was first asked for: the part's approval, or the first `fix_token` when none was recorded. */
  readonly createdAt: number;
  readonly writtenAt: number | null;
  /** The fork head another write left, on which the part is tried again before its write; null when none did. */
  readonly retrialHead: string | null;
  /** The trial asked on `retrialHead`, or null. */
  readonly retrialTrial: number | null;
  /** The head the part's last passing re-trial ran on, or null. */
  readonly trialledHead: string | null;
  /** Each module a kept write copied, with the blob it wrote; empty when it copied none. */
  readonly copies: ReadonlyMap<string, string>;
}

/** A write as a waiting message names it. */
function writeName(grant: FixGrant): string {
  if (grant.writer === "task") return `the run of edit task ${grant.partId.slice("task:".length)}`;
  const copy = copyWriteOf(grant);
  if (copy !== undefined) return `the copy of the originating change's modules for part ${copy.partId} revision ${grant.revision}`;
  return `the write of part ${grant.partId} revision ${grant.revision}`;
}

function copiesOf(json: SqlValue | undefined): ReadonlyMap<string, string> {
  if (typeof json !== "string") return new Map();
  return new Map(Object.entries(JSON.parse(json) as Record<string, string>));
}

function grantOf(row: Row): FixGrant {
  const nullable = (key: string) => (row[key] === null ? null : (row[key] as string));
  const number = (key: string) => (row[key] === null ? null : Number(row[key]));
  return {
    id: Number(row["id"]),
    featureId: row["feature_id"] as string,
    planId: row["plan_id"] as string,
    partId: row["part_id"] as string,
    revision: Number(row["revision"]),
    targetFeatureId: row["target_feature_id"] as string,
    writer: row["writer"] as GrantWriter,
    state: row["state"] as FixGrantState,
    parent: nullable("parent"),
    rebased: Number(row["rebased"]) === 1,
    claimedBy: nullable("claimed_by"),
    leaseUntil: number("lease_until"),
    commitSha: nullable("commit_sha"),
    recordId: nullable("record_id"),
    createdAt: Number(row["created_at"]),
    writtenAt: number("written_at"),
    retrialHead: nullable("retrial_head"),
    retrialTrial: number("retrial_trial"),
    trialledHead: nullable("trialled_head"),
    copies: copiesOf(row["copies"]),
  };
}

/** The writes asked for, one per revision of a part, on the ProjectAgent. */
export class FixGrantStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of [...FIX_GRANT_SCHEMA, ...RUN_FAILURE_SCHEMA]) db.exec(statement);
    // Column names and definitions come from the constant above, never from input.
    const present = new Set(db.exec(`PRAGMA table_info(FixWriteGrant)`).map((row) => row["name"]));
    for (const [name, definition] of GRANT_COLUMNS) {
      if (!present.has(name)) db.exec(`ALTER TABLE FixWriteGrant ADD COLUMN ${definition}`);
    }
  }

  /** The write of one revision of a part, made `queued` for `writer` when there is none yet. */
  open(featureId: string, planId: string, part: Pick<PlanPart, "partId" | "revision">, target: string, writer: GrantWriter): FixGrant {
    this.#db.exec(
      `INSERT OR IGNORE INTO FixWriteGrant (feature_id, plan_id, part_id, revision, target_feature_id, writer, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      featureId,
      planId,
      part.partId,
      part.revision,
      target,
      writer,
      this.#now(),
    );
    return this.get(part.partId, part.revision) as FixGrant;
  }

  get(partId: string, revision: number): FixGrant | undefined {
    const [row] = this.#db.exec(`SELECT * FROM FixWriteGrant WHERE part_id = ? AND revision = ?`, partId, revision);
    return row === undefined ? undefined : grantOf(row);
  }

  byId(id: number): FixGrant | undefined {
    const [row] = this.#db.exec(`SELECT * FROM FixWriteGrant WHERE id = ?`, id);
    return row === undefined ? undefined : grantOf(row);
  }

  /** Marks the write granted with the parent it must fast-forward; a runner's claim holds until `leaseUntil`. */
  grant(id: number, parent: string, rebased: boolean, claimedBy: string | null, leaseUntil: number | null): void {
    this.#db.exec(
      `UPDATE FixWriteGrant SET state = 'granted', parent = ?, rebased = ?, claimed_by = ?, lease_until = ?, granted_at = ? WHERE id = ?`,
      parent,
      rebased ? 1 : 0,
      claimedBy,
      leaseUntil,
      this.#now(),
      id,
    );
  }

  /** Puts open write `id` back in its place in the fork's order, holding no token. */
  requeue(id: number): void {
    this.#db.exec(`UPDATE FixWriteGrant SET state = 'queued', claimed_by = NULL, lease_until = NULL WHERE id = ? AND state = 'granted'`, id);
  }

  /** A migration edit task's run holds the fork for its claim, until `leaseUntil`. */
  hold(id: number, claimedBy: string, leaseUntil: number): void {
    this.#db.exec(
      `UPDATE FixWriteGrant SET state = 'granted', claimed_by = ?, lease_until = ?, granted_at = ? WHERE id = ? AND state IN ${OPEN_STATES}`,
      claimedBy,
      leaseUntil,
      this.#now(),
      id,
    );
  }

  /** Keeps write `id` as `commit`, with each module it copied and the blob it wrote there. */
  written(id: number, commit: string, recordId: string, copies: ReadonlyMap<string, string> = new Map()): void {
    this.#db.exec(
      `UPDATE FixWriteGrant SET state = 'written', commit_sha = ?, record_id = ?, written_at = ?, copies = ? WHERE id = ?`,
      commit,
      recordId,
      this.#now(),
      copies.size === 0 ? null : JSON.stringify(Object.fromEntries(copies)),
      id,
    );
  }

  /** Each module's blobs that kept writes of feature `featureId`'s plans copied into `target`'s fork. */
  copiedInto(featureId: string, target: string): Map<string, Set<string>> {
    const copied = new Map<string, Set<string>>();
    const rows = this.#db.exec(
      `SELECT * FROM FixWriteGrant WHERE feature_id = ? AND target_feature_id = ? AND state = 'written' AND copies IS NOT NULL ORDER BY id`,
      featureId,
      target,
    );
    for (const [path, hash] of rows.flatMap((row) => [...grantOf(row).copies])) {
      if (!copied.has(path)) copied.set(path, new Set());
      copied.get(path)?.add(hash);
    }
    return copied;
  }

  withdraw(id: number): void {
    this.#db.exec(`UPDATE FixWriteGrant SET state = 'withdrawn' WHERE id = ? AND state != 'written'`, id);
  }

  /**
   * Queues granted write `id` again when `runnerId` holds its claim, so the next claim of any runner
   * prepares it afresh with a new token. The plan's feature is the one whose person hears of a stop.
   */
  release(id: number, runnerId: string): StoreRelease {
    const found = this.byId(id);
    if (found === undefined || found.writer !== "runner") return { status: "rejected", reason: "not_found", message: `no runner write ${id}` };
    if (found.state !== "granted") return { status: "rejected", reason: "conflict", message: `write ${id} is ${found.state}, not granted` };
    if (found.claimedBy !== runnerId) return { status: "rejected", reason: "forbidden", message: `write ${id} is claimed by another runner` };
    this.#db.exec(`UPDATE FixWriteGrant SET state = 'queued', claimed_by = NULL, lease_until = NULL WHERE id = ? AND state = 'granted'`, id);
    return { status: "released", featureId: found.featureId };
  }

  /** The writes into `target`'s fork not yet made, in approval order. */
  openOn(target: string): FixGrant[] {
    return this.#db.exec(`SELECT * FROM FixWriteGrant WHERE target_feature_id = ? AND state IN ${OPEN_STATES} ORDER BY id`, target).map(grantOf);
  }

  /** Every write not yet made, into any fork, in approval order. */
  allOpen(): FixGrant[] {
    return this.#db.exec(`SELECT * FROM FixWriteGrant WHERE state IN ${OPEN_STATES} ORDER BY id`).map(grantOf);
  }

  /**
   * Why open write `grant` may not be granted now, from the table alone, or null when it is its turn:
   * another write into the fork holds a token, a write approved earlier still waits there, or its trial
   * on the head another write left has not passed. A write whose part moved on still counts here.
   */
  waitsFor(grant: FixGrant): string | null {
    const now = this.#now();
    for (const other of this.openOn(grant.targetFeatureId)) {
      if (other.id === grant.id) continue;
      if (other.state === "granted" && (other.leaseUntil === null || other.leaseUntil > now)) {
        return `${writeName(other)} holds feature ${grant.targetFeatureId}'s fork`;
      }
      if (other.id < grant.id) return `${writeName(other)} came first and is written into feature ${grant.targetFeatureId}'s fork before it`;
    }
    if (grant.retrialHead !== null && grant.trialledHead !== grant.retrialHead) {
      return `the part is tried again on feature ${grant.targetFeatureId}'s fork head ${grant.retrialHead}, which another plan's fix moved`;
    }
    return null;
  }

  /** Asks write `id` to wait for trial `trialId` on fork head `head`, which another write left. */
  retrial(id: number, head: string, trialId: number | null): void {
    this.#db.exec(`UPDATE FixWriteGrant SET retrial_head = ?, retrial_trial = ? WHERE id = ? AND state IN ${OPEN_STATES}`, head, trialId, id);
  }

  /** The open write waiting on re-trial `trialId`, or undefined. */
  byRetrial(trialId: number): FixGrant | undefined {
    const [row] = this.#db.exec(`SELECT * FROM FixWriteGrant WHERE retrial_trial = ? AND state IN ${OPEN_STATES}`, trialId);
    return row === undefined ? undefined : grantOf(row);
  }

  /** The kept write whose commit is `commit`, or undefined. */
  writtenAs(commit: string): FixGrant | undefined {
    const [row] = this.#db.exec(`SELECT * FROM FixWriteGrant WHERE state = 'written' AND commit_sha = ? ORDER BY id LIMIT 1`, commit);
    return row === undefined ? undefined : grantOf(row);
  }

  /** The part's trial on `head` passed: write `id` may take its turn there. */
  trialled(id: number, head: string): void {
    this.#db.exec(`UPDATE FixWriteGrant SET trialled_head = ? WHERE id = ?`, head, id);
  }

  /** The writes kept into any of `targets`' forks at or after `since`, oldest first. */
  writtenSince(targets: readonly string[], since: number): FixGrant[] {
    if (targets.length === 0) return [];
    return this.#db
      .exec(
        `SELECT * FROM FixWriteGrant WHERE state = 'written' AND written_at >= ? AND target_feature_id IN (${targets.map(() => "?").join(", ")}) ORDER BY id`,
        since,
        ...targets,
      )
      .map(grantOf);
  }

  /** The runner's writes to claim: queued ones and granted ones whose claim ran out. */
  claimable(): FixGrant[] {
    return this.#db
      .exec(
        `SELECT * FROM FixWriteGrant WHERE writer = 'runner' AND (state = 'queued' OR (state = 'granted' AND lease_until < ?)) AND ${notStopped("fix-write", "id")} ORDER BY id`,
        this.#now(),
      )
      .map(grantOf);
  }
}

/** The binding's object reads plus `log`, which finds a fork's head. */
export interface ForkReader extends GitObjectReader {
  log(options: { ref: string; limit: number; offset?: number }): Promise<readonly { readonly hash: string }[]>;
}

/** Reads one Artifacts repo through the binding for the length of `use`. */
export type ForkReading = <T>(repo: string, use: (reader: ForkReader) => Promise<T>) => Promise<T>;

export interface FixWriteDeps {
  readonly features: FeatureStore;
  readonly routes: PlanRouteStore;
  readonly grants: FixGrantStore;
  /** The plan store of one feature: its Durable Object (plan-store.ts). */
  readonly keeper: (featureId: string) => PlanKeeper;
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly readFork: ForkReading;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** Tells a person's open dashboards that their inbox or a plan they follow changed. */
  readonly notify: (personId: string) => void;
  readonly now?: () => number;
  /**
   * Whether session `sessionId` holds the open edit task that writes this revision of the part
   * (edit-tasks.ts): the target feature's builder or a steward the task was routed to. Absent, only
   * the originating agent writes.
   */
  readonly holds?: (sessionId: string, partId: string, revision: number) => boolean;
  /** The approved parts of the split's migration plans (migration-plans.ts); absent, their writes are withdrawn. */
  readonly migration?: MigrationWrites;
  /** Whether the feature's start waits on an open overlap lock: its fork gets no write yet. Absent is never. */
  readonly locked?: (featureId: string) => boolean;
  /**
   * How long a granted write holds its fork: the lifetime of the write token the Worker mints
   * (PENGUIN_FIX_TOKEN_TTL_MINUTES). Defaults to FIX_WRITE_LEASE_MS.
   */
  readonly tokenLeaseMs?: number;
  /**
   * Called once a write is kept, so every other write still waiting on that fork is tried again on
   * the new head before it is granted (fix-retrial.ts). Absent, nothing is tried again.
   */
  readonly written?: (grant: FixGrant, commit: string) => Promise<void>;
}

/** What fix writes read and tell about a migration part (migration-plans.ts). */
export interface MigrationWrites {
  /** The approved part's write, or why it can no longer be written. */
  approved(partId: string): Promise<ApprovedWrite | FixRejection>;
  /** The target fork moved to `head` and the patch no longer applies there: the part becomes an edit task. */
  headMoved(partId: string, head: string, problem: string): Promise<void>;
  /** The runner's commit was kept: the part is written. */
  written(partId: string, commit: string, recordId: string): Promise<void>;
  /** Asks the part's trial on `head`, the fork head another write left; answers the trial's id, or null. */
  retry?(partId: string, head: string): Promise<number | null>;
}

export type FixRejectReason = FeatureRejectReason | "not_approved" | "head_moved" | "waiting" | "copy_conflict";

export type FixRejection = { readonly status: "rejected"; readonly reason: FixRejectReason; readonly message: string };

/** A write a writer may make: the spec and the affected fork's Artifacts repo name, to mint the token on. */
export type FixGrantOutcome = { readonly status: "ok"; readonly spec: FixWriteSpec; readonly repo: string } | FixRejection;

export type FixWriteOutcome =
  | {
      readonly status: "ok";
      readonly write: FixWrite;
      /** From the write being asked for (approval or first `fix_token`) to the commit being kept. */
      readonly durationMs: number;
    }
  | FixRejection;

/** The part a write names, as the agent or a grant names it. */
export interface FixPartInput {
  readonly feature: unknown;
  readonly part: unknown;
  readonly revision: unknown;
}

const rejected = (reason: FixRejectReason, message: string): FixRejection => ({ status: "rejected", reason, message });
const SHA = /^[0-9a-f]{40}$/u;
const PART_ID_MAX_LENGTH = 128;

/** An approved write: the part, its patch against `base` and the fork it goes into. */
export interface ApprovedWrite {
  /** The feature whose plan the part is in. */
  readonly featureId: string;
  readonly plan: Pick<Plan, "planId" | "proposedBy" | "person">;
  readonly part: Pick<PlanPart, "partId" | "revision" | "kind" | "scopes" | "approvedBy"> & {
    readonly diff: Pick<PlanPart["diff"], "files" | "ref">;
  };
  readonly patch: string;
  readonly base: string;
  readonly target: Feature & { readonly repo: string };
  /** For a copy write: the originating change's revision its modules come from. It carries no patch. */
  readonly copiedFrom?: string;
}

export interface ApprovedPart extends ApprovedWrite {
  readonly plan: Plan;
  readonly part: PlanPart & { readonly place: { readonly kind: "feature"; readonly feature: string } };
}

export const isRejection = (value: unknown): value is FixRejection =>
  typeof value === "object" && value !== null && (value as { status?: unknown }).status === "rejected";

/**
 * The current revision of an approved part on a running feature in the feature's newest plan, or why
 * no fix may be written for it.
 */
export async function approvedPart(deps: FixWriteDeps, input: FixPartInput): Promise<ApprovedPart | FixRejection> {
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const { part: partId, revision } = input;
  if (typeof partId !== "string" || partId.length > PART_ID_MAX_LENGTH || !partId.startsWith(`${featureId}/v`)) {
    return rejected("invalid", `the part must be the id of a part of feature ${featureId}'s plan`);
  }
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return rejected("invalid", "the revision must be the part's revision number");
  }
  const plan = await deps.keeper(featureId).latestPlan(featureId);
  const part = plan?.parts.find((each) => each.partId === partId);
  if (plan === undefined || part === undefined) return rejected("not_found", `part ${partId} is not in feature ${featureId}'s newest plan`);
  if (part.revision !== revision) return rejected("conflict", `part ${partId} is at revision ${part.revision}, not ${revision}`);
  if (part.approvalState !== "approved" || part.approvedBy === null) {
    return rejected("not_approved", `revision ${revision} of part ${partId} is ${part.approvalState.replaceAll("_", " ")}, not approved; no fix is written for it`);
  }
  if (part.place.kind !== "feature") {
    return rejected("invalid", `part ${partId} fixes code on main in feature ${featureId}'s own fork; no other fork is written`);
  }
  // A verify part has no patch: its write only copies the originating change's modules.
  const verify = part.kind === "verify";
  if (!verify && (part.diff.source !== "patch" || part.diff.patch === null || part.diff.base === null)) {
    return rejected("invalid", `part ${partId} carries no patch to write`);
  }
  const target = deps.features.get(part.place.feature);
  if (target?.repo == null) return rejected("not_found", `feature ${part.place.feature} has no fork`);
  const base = verify ? await forkHead(deps, target.repo) : part.diff.base;
  if (base === null) return rejected("not_found", `feature ${target.id}'s fork has no ${FIX_WRITE_BRANCH} branch`);
  // A landed fork is read-only (PRD 4.5 step 5): no fix goes into it, and a landed plan writes none.
  for (const feature of [target, deps.features.get(featureId)]) {
    const readOnly = feature === undefined ? undefined : readOnlyReason(feature);
    if (readOnly !== undefined) return rejected("conflict", readOnly);
  }
  return {
    featureId,
    plan,
    part: part as ApprovedPart["part"],
    patch: part.diff.patch ?? "",
    base,
    target: target as ApprovedPart["target"],
  };
}

/** The approved write a grant names: a migration part's, or a plan part's current revision. */
export async function grantedWrite(deps: FixWriteDeps, grant: FixGrant): Promise<ApprovedWrite | FixRejection> {
  const copy = copyWriteOf(grant);
  if (copy !== undefined) return copyWrite(deps, grant, copy);
  if (!isMigrationPlanId(grant.planId)) return approvedPart(deps, { feature: grant.featureId, part: grant.partId, revision: grant.revision });
  if (deps.migration === undefined) return rejected("not_found", `part ${grant.partId} of migration plan ${grant.planId} is not known here`);
  return deps.migration.approved(grant.partId);
}

/**
 * The originating change's current revision: its newest revision across every scope of its plan
 * (part-trial.ts `newestRevision`). Each copy comes from it, so a fork holds the bytes main will take.
 */
export function originRevision(plan: Plan): string {
  return newestRevision(plan, { scopes: plan.parts.flatMap((part) => part.scopes) });
}

/**
 * The approved part a copy write copies for, written onto the fork's head with no patch, while the
 * originating change still stands at the revision the write was opened for.
 */
async function copyWrite(deps: FixWriteDeps, grant: FixGrant, copy: { readonly partId: string; readonly source: string }): Promise<ApprovedPart | FixRejection> {
  const approved = await approvedPart(deps, { feature: grant.featureId, part: copy.partId, revision: grant.revision });
  if (isRejection(approved)) return approved;
  const source = originRevision(approved.plan);
  if (source !== copy.source) return rejected("conflict", `the originating change moved from revision ${copy.source} to ${source}`);
  const head = await forkHead(deps, approved.target.repo);
  if (head === null) return rejected("not_found", `feature ${approved.target.id}'s fork has no ${FIX_WRITE_BRANCH} branch`);
  return { ...approved, patch: "", base: head, copiedFrom: source };
}

/** The fork's head on its `main`, or null when the branch has no commit. */
async function forkHead(deps: FixWriteDeps, repo: string): Promise<string | null> {
  const [head] = await deps.readFork(repo, (reader) => reader.log({ ref: FIX_WRITE_BRANCH, limit: 1 }));
  return head?.hash ?? null;
}

/** The patch's files, each checked to lie inside the part's scopes and in its approved diff. */
function checkedFiles(approved: ApprovedWrite, scopeMap: ScopeMap): PlanFileDiff[] | FixRejection {
  // A verify part's write has no patch, only copies.
  if (approved.patch === "") return [];
  const parsed = parsePatch(approved.patch);
  if (!parsed.ok) return rejected("invalid", `the approved patch no longer parses: ${parsed.message}`);
  const scopes = new Set(approved.part.scopes);
  const approvedPaths = new Set(approved.part.diff.files.map((file) => file.path));
  for (const file of parsed.files) {
    const scope = scopeForPath(scopeMap, file.path);
    if (scope === undefined || !scopes.has(scope) || !approvedPaths.has(file.path)) {
      return rejected("invalid", `${file.path} lies outside approved part ${approved.part.partId}; nothing is written`);
    }
  }
  return parsed.files;
}

/**
 * Where the patch applies at commit `head` of the fork: null when every file applies there, or the
 * first file and hunk that does not.
 */
async function applyProblem(deps: FixWriteDeps, repo: string, head: string, files: readonly PlanFileDiff[]): Promise<string | null> {
  return deps.readFork(repo, async (reader) => {
    const commit = await reader.readCommit(head);
    if (commit === null) return `${head} is not in the fork`;
    for (const file of files) {
      const applied = applyPatchFile(file, await readFileText(reader, commit.treeHash, file.path));
      if (!applied.ok) return applied.message;
    }
    return null;
  });
}

/**
 * Sends a part whose fork head moved, and whose patch no longer applies there, back to the originating
 * agent: Penguin's request names the new head the revision must apply to. It counts no round, and the
 * part's author approves the revision again.
 */
async function sendBack(deps: FixWriteDeps, approved: ApprovedPart, head: string, problem: string): Promise<void> {
  const { featureId, plan, part } = approved;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "plan_part_rebase", { penguin: true }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision: part.revision,
      base: approved.base,
      fork_head: head,
    }),
  );
  const text = `Feature ${approved.part.place.feature}'s fork moved from ${approved.base} to ${head} and the approved patch no longer applies there (${problem}). Revise the part as a patch against ${head}.`;
  await returnToOriginator(deps, approved, head, text, record);
}

/**
 * Puts approved part `approved` back to the originating agent as `change_requested` with Penguin's
 * request `text`, which names fork head `head` and cites signed record `record`. The part's author then
 * approves the revision again.
 */
export async function returnToOriginator(deps: FixWriteDeps, approved: ApprovedPart, head: string, text: string, record: FeatureRecord): Promise<void> {
  const { featureId, plan, part } = approved;
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const next: PlanPart = {
    ...part,
    approvalState: "change_requested",
    approvedBy: null,
    changeRequest: {
      by: "penguin",
      revision: part.revision,
      text,
      at,
      recordId: record.record_id,
      forkHead: head,
    },
  };
  if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: part.approvalState }))) return;
  deps.features.addRecord(record);
  deps.routes.set(featureId, next);
  deps.notify(plan.person);
  deps.notify(part.owner);
}

/**
 * The spec of one write of an approved part: the patch's paths checked, and the parent it must
 * fast-forward read from the fork. A head that moved past the patch's base and no longer takes the
 * patch sends the part back for revision and refuses.
 */
async function prepare(
  deps: FixWriteDeps,
  approved: ApprovedWrite,
  grant: FixGrant,
  writtenBy: string,
  headMoved: (head: string, problem: string) => Promise<string>,
): Promise<FixGrantOutcome> {
  const { plan, part, target } = approved;
  const files = checkedFiles(approved, await deps.scopeMap());
  if (isRejection(files)) return files;
  const head = await forkHead(deps, target.repo);
  if (head === null) return rejected("not_found", `feature ${target.id}'s fork has no ${FIX_WRITE_BRANCH} branch`);
  let parent = approved.base;
  if (head !== approved.base) {
    const problem = await applyProblem(deps, target.repo, head, files);
    if (problem !== null) {
      return rejected("head_moved", `feature ${target.id}'s fork moved to ${head} and the patch no longer applies there; ${await headMoved(head, problem)}`);
    }
    parent = head;
  }
  // The check runner's write also copies the originating change's modules the fork imports. An
  // agent's write and a migration part's carry none; a copy write carries them for the agent's part.
  let copy: ModuleCopy | null = null;
  if (grant.writer === "runner" && !isMigrationPlanId(plan.planId)) {
    const read = await copyFor(deps, approved as ApprovedPart, parent, files);
    if (read.status === "refused") return rejected("conflict", read.message);
    if (read.status === "conflict") {
      await returnCopyConflict(deps, approved as ApprovedPart, parent, read);
      return rejected("copy_conflict", `${read.message}; part ${part.partId} went back to the originating agent with the fork's lines`);
    }
    copy = read.copy;
  }
  const spec: FixWriteSpec = {
    writeId: grant.id,
    feature: approved.featureId,
    planId: plan.planId,
    partId: part.partId,
    revision: part.revision,
    kind: part.kind,
    // A task write never reaches here: its run commits its own change.
    writer: grant.writer as FixWriter,
    target: target.id,
    fork: `feature-${target.id}`,
    branch: FIX_WRITE_BRANCH,
    parent,
    rebased: parent !== approved.base,
    paths: files.map((file) => file.path),
    patch: approved.patch,
    ...(copy === null ? {} : { copy }),
    message: fixCommitMessage({
      partId: part.partId,
      revision: part.revision,
      target: target.id,
      approvedBy: part.approvedBy as string,
      writtenBy,
      ref: part.diff.ref,
      ...(approved.copiedFrom === undefined ? {} : { copiedFrom: approved.copiedFrom }),
    }),
  };
  return { status: "ok", spec, repo: target.repo };
}

/**
 * `fix_token`: a write on the affected fork for `caller`'s session, which must be the originating agent
 * named in the plan, working on the originating feature, for the current approved revision of a
 * behavioural part not yet written. The Worker mints the token on the grant's repo alone.
 */
export async function agentFixGrant(
  deps: FixWriteDeps,
  heartbeat: (caller: string, sessionId: string) => SessionOutcome,
  caller: string,
  sessionId: string,
  input: FixPartInput,
): Promise<FixGrantOutcome> {
  const live = heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  if (holdsTask(deps, sessionId, input)) return taskFixGrant(deps, input, live.session.handle);
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature ${featureId}`);
  if (feature.personId !== caller || deps.features.featureOfSession(sessionId) !== featureId) {
    return rejected("forbidden", `only the originating agent of feature ${featureId}'s plan writes its fixes`);
  }
  const approved = await approvedPart(deps, input);
  if (isRejection(approved)) return approved;
  if (live.session.handle !== approved.plan.proposedBy) {
    return rejected("forbidden", `the write token goes to ${approved.plan.proposedBy}, the originating agent named in plan ${approved.plan.planId}`);
  }
  return grantAgentWrite(deps, approved, approved.plan.proposedBy, deps.tokenLeaseMs ?? FIX_WRITE_LEASE_MS);
}

/**
 * The write of an approved behavioural part for `holder`, the identity its edit task was routed to
 * (edit-tasks.ts): the same checks as `fix_token`, with the holder named as the writer in the commit
 * message. The caller has checked that `holder` holds the task.
 */
export async function taskFixGrant(deps: FixWriteDeps, input: FixPartInput, holder: string, leaseMs: number = deps.tokenLeaseMs ?? FIX_WRITE_LEASE_MS): Promise<FixGrantOutcome> {
  const approved = await approvedPart(deps, input);
  if (isRejection(approved)) return approved;
  return grantAgentWrite(deps, approved, holder, leaseMs);
}

/**
 * The write of an approved behavioural part for `writtenBy`, once it is the fork's turn. The grant
 * holds the fork for `leaseMs`, the lifetime of the token minted on it.
 */
async function grantAgentWrite(deps: FixWriteDeps, approved: ApprovedPart, writtenBy: string, leaseMs: number): Promise<FixGrantOutcome> {
  if (approved.part.kind === "mechanical" || approved.part.kind === "verify") {
    return rejected("forbidden", `part ${approved.part.partId} is ${approved.part.kind}: Penguin's check runner writes it`);
  }
  const grant = deps.grants.open(approved.featureId, approved.plan.planId, approved.part, approved.target.id, "agent");
  if (grant.state === "written") {
    return rejected("conflict", `revision ${grant.revision} of part ${grant.partId} is already written as ${grant.commitSha}`);
  }
  const waiting = await forkTurn(deps, grant);
  if (waiting !== null) return rejected("waiting", `the fix of part ${grant.partId} waits: ${waiting}; ask again once it is written`);
  const prepared = await prepare(deps, approved, grant, writtenBy, revise(deps, approved));
  if (prepared.status === "ok") deps.grants.grant(grant.id, prepared.spec.parent, prepared.spec.rebased, null, (deps.now ?? Date.now)() + leaseMs);
  else if (prepared.reason === "head_moved") deps.grants.withdraw(grant.id);
  return prepared;
}

/**
 * Why `grant` waits for its turn on its fork, or null when it may be granted now. A write approved
 * earlier whose part has since moved on (revised, reversed, superseded by a newer plan, or its feature
 * landed) is withdrawn first, so it holds no place in the order.
 */
async function forkTurn(deps: FixWriteDeps, grant: FixGrant): Promise<string | null> {
  await withdrawMovedOn(deps, deps.grants.openOn(grant.targetFeatureId).filter((other) => other.id !== grant.id));
  return deps.grants.waitsFor(grant);
}

/**
 * Withdraws each of `grants` (every open write when omitted) whose part moved on, so it holds no place
 * in its fork's order. A claim that reads the order from the table alone calls this first.
 */
export async function withdrawMovedOn(deps: FixWriteDeps, grants: readonly FixGrant[] = deps.grants.allOpen()): Promise<void> {
  for (const other of grants) {
    // A migration edit task's write follows its task (edit-work.ts), not a plan.
    if (other.writer === "task") continue;
    if (isRejection(await grantedWrite(deps, other))) deps.grants.withdraw(other.id);
  }
}

/** `holder` reports the commit it pushed for a write `taskFixGrant` granted it. */
export async function taskFixReport(deps: FixWriteDeps, input: FixPartInput, holder: string, commit: unknown): Promise<FixWriteOutcome> {
  const grant = typeof input.part === "string" && typeof input.revision === "number" ? deps.grants.get(input.part, input.revision) : undefined;
  if (grant === undefined || grant.writer !== "agent") return rejected("not_found", "no write was granted for that part and revision");
  return recordFixWrite(deps, grant, holder, commit, holder);
}

function holdsTask(deps: FixWriteDeps, sessionId: string, input: FixPartInput): boolean {
  return typeof input.part === "string" && typeof input.revision === "number" && deps.holds?.(sessionId, input.part, input.revision) === true;
}

/** A plan part whose fork head moved goes back to the originating agent (`sendBack`). */
function revise(deps: FixWriteDeps, approved: ApprovedPart): (head: string, problem: string) => Promise<string> {
  return async (head, problem) => {
    await sendBack(deps, approved, head, problem);
    return `part ${approved.part.partId} went back to the originating agent to revise`;
  };
}

/**
 * On an approval: opens the write of a part on a running feature, which places it in its fork's
 * order. The check runner claims a mechanical part's write; the originating agent or the holder of its
 * fix task asks for a behavioural one's.
 */
export function openFixWrite(grants: FixGrantStore, featureId: string, plan: Plan, part: PlanPart): void {
  if (part.place.kind !== "feature" || part.approvalState !== "approved") return;
  // A verify part's write only copies the originating change's modules the fork imports; its claim
  // withdraws it when there are none.
  grants.open(featureId, plan.planId, part, part.place.feature, part.kind === "behavioural" ? "agent" : "runner");
}

/** The originating change's modules the check runner copies into the fork at `head`, with `files` the part's patch. */
async function copyFor(deps: FixWriteDeps, approved: ApprovedPart, head: string, files: readonly PlanFileDiff[]): Promise<CopyReading> {
  const origin = deps.features.get(approved.featureId);
  if (origin?.repo == null) return { status: "refused", message: `feature ${approved.featureId} has no fork` };
  const scopeMap = await deps.scopeMap();
  const scopePaths = approved.part.scopes.flatMap((scope) => scopeMap.scopes.get(scope)?.paths ?? []);
  // The originating change as it now stands: its newest revision, which holds the checkpoint and
  // every revision before it, so the fork's copies are the bytes main will take.
  const checkpoint = originRevision(approved.plan);
  const { baseline } = approved.plan.facts.change;
  // A module still at a revision Penguin copied before takes the newer one.
  const earlier = deps.grants.copiedInto(approved.featureId, approved.target.id);
  return deps.readFork(origin.repo as string, (originReader) =>
    deps.readFork(approved.target.repo, (fork) => readCopy({ origin: originReader, checkpoint, baseline, fork, head, scopePaths, patch: files, earlier })),
  );
}

/** The longest diff of the fork's own lines a returned part quotes: the request stays under its limit. */
const CONFLICT_LINES_LENGTH = 1_400;

/**
 * Sends a part whose fork changed one of the originating change's modules itself back to the
 * originating agent as `change_requested`, with the fork's lines, as part of its own change. Its
 * session reads the request in `get_work` (`ownPlan.parts[].changeRequest`). A signed `copy_conflict`
 * record names the module and the fork head.
 */
export async function returnCopyConflict(deps: FixWriteDeps, approved: ApprovedPart, head: string, conflict: { readonly path: string; readonly lines: string }): Promise<void> {
  const { featureId, plan, part } = approved;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "copy_conflict", { penguin: true }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision: part.revision,
      fork: `feature-${part.place.feature}`,
      fork_head: head,
      path: conflict.path,
    }),
  );
  const lines = conflict.lines.length > CONFLICT_LINES_LENGTH ? `${conflict.lines.slice(0, CONFLICT_LINES_LENGTH)}\n...` : conflict.lines;
  const text = [
    `Feature ${part.place.feature}'s fork changed ${conflict.path} itself at ${head}, so Penguin does not copy your revision of it there.`,
    `Fold the fork's lines into ${conflict.path} in your own change; Penguin copies the module once your revision holds them.`,
    lines,
  ].join("\n");
  await returnToOriginator(deps, approved, head, text, record);
}

/**
 * On an approval: opens a copy write for each approved part of `plan` on a running feature at the
 * originating change's current revision, `approvedNow` counted as approved. A mechanical or verify
 * part whose own write is not yet made copies the modules in that write, so it gets none. The claim
 * withdraws a copy write whose fork already holds every module.
 */
export function openCopyWrites(grants: FixGrantStore, featureId: string, plan: Plan, approvedNow?: PlanPart): void {
  if (isMigrationPlanId(plan.planId)) return;
  const source = originRevision(plan);
  for (const stored of plan.parts) {
    const part = stored.partId === approvedNow?.partId ? approvedNow : stored;
    if (part.place.kind !== "feature" || part.approvalState !== "approved") continue;
    const own = grants.get(part.partId, part.revision);
    if (part.kind !== "behavioural" && (own === undefined || own.state === "queued" || own.state === "granted")) continue;
    grants.open(featureId, plan.planId, { partId: copyWriteKey(part.partId, source), revision: part.revision }, part.place.feature, "runner");
  }
}

/**
 * For a land of `plan`: each affected fork, at its head in `targets`, that does not yet hold the
 * originating change's current revision of every module it imports, with why. Each such fork gets a
 * copy write of that revision; a fork that changed a module itself sends its part back to the
 * originating agent. An empty answer lets the land go on.
 */
export async function copiesBehind(deps: FixWriteDeps, plan: Plan, targets: readonly { readonly feature: string; readonly sha: string }[]): Promise<string[]> {
  if (isMigrationPlanId(plan.planId)) return [];
  const source = originRevision(plan);
  const behind: string[] = [];
  for (const part of plan.parts) {
    if (part.place.kind !== "feature" || part.approvalState !== "approved") continue;
    const place = part.place.feature;
    const target = targets.find((each) => each.feature === place);
    // The affected feature landed or stopped: it takes main like anyone.
    if (target === undefined) continue;
    const approved = await approvedPart(deps, { feature: plan.featureId, part: part.partId, revision: part.revision });
    if (isRejection(approved)) continue;
    const read = await copyFor(deps, approved, target.sha, []);
    if (read.status === "ok" && read.copy === null) continue;
    if (read.status === "conflict") {
      await returnCopyConflict(deps, approved, target.sha, read);
      behind.push(`${read.message}; part ${part.partId} went back to the originating agent`);
      continue;
    }
    if (read.status === "refused") {
      behind.push(read.message);
      continue;
    }
    deps.grants.open(plan.featureId, plan.planId, { partId: copyWriteKey(part.partId, source), revision: part.revision }, place, "runner");
    behind.push(`feature ${place}'s fork does not yet hold ${read.copy?.paths.join(", ")} at revision ${source.slice(0, 12)}`);
  }
  return behind;
}

/**
 * The check runner's claim: each queued write of a mechanical part that is still approved at its
 * revision, with its spec, held for FIX_WRITE_LEASE_MS. A write whose part moved on is withdrawn.
 */
export async function claimRunnerWrites(
  deps: FixWriteDeps,
  caller: BridgeCaller,
): Promise<{ readonly status: "ok"; readonly writes: readonly { readonly spec: FixWriteSpec; readonly repo: string }[] } | { readonly status: "forbidden"; readonly message: string }> {
  if (caller.role !== "runner") return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
  const now = deps.now ?? Date.now;
  const writes: { spec: FixWriteSpec; repo: string }[] = [];
  for (const grant of deps.grants.claimable()) {
    // A fork whose start waits on an overlap lock gets no token yet; the write stays queued.
    if (deps.locked?.(grant.targetFeatureId) === true) continue;
    const approved = await grantedWrite(deps, grant);
    // The runner writes a behavioural part's copies, never its patch.
    if (isRejection(approved) || (approved.part.kind === "behavioural" && approved.copiedFrom === undefined)) {
      deps.grants.withdraw(grant.id);
      continue;
    }
    // A write that waits for its fork's turn stays queued for a later claim.
    if ((await forkTurn(deps, grant)) !== null) continue;
    const migration = deps.migration;
    const headMoved =
      isMigrationPlanId(grant.planId) && migration !== undefined
        ? async (head: string, problem: string) => {
            await migration.headMoved(grant.partId, head, problem);
            return `migration part ${grant.partId} became an edit task`;
          }
        : revise(deps, approved as ApprovedPart);
    const prepared = await prepare(deps, approved, grant, RUNNER_WRITER, headMoved);
    if (prepared.status !== "ok") {
      // A moved head or a module the fork changed itself sent the part back to the originating agent;
      // anything else stays queued for the next claim.
      if (prepared.reason === "head_moved" || prepared.reason === "copy_conflict") deps.grants.withdraw(grant.id);
      continue;
    }
    // A verify part or a copy write whose fork already holds every module it imports has nothing to write.
    if (prepared.spec.patch === "" && prepared.spec.copy === undefined) {
      deps.grants.withdraw(grant.id);
      continue;
    }
    deps.grants.grant(grant.id, prepared.spec.parent, prepared.spec.rebased, caller.bridgeId, now() + FIX_WRITE_LEASE_MS);
    writes.push(prepared);
  }
  return { status: "ok", writes };
}

/** `report_fix_write`: the originating agent reports the commit it pushed for a granted write. */
export async function agentFixReport(
  deps: FixWriteDeps,
  heartbeat: (caller: string, sessionId: string) => SessionOutcome,
  caller: string,
  sessionId: string,
  input: FixPartInput & { readonly commit: unknown },
): Promise<FixWriteOutcome> {
  const live = heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  if (holdsTask(deps, sessionId, input)) return taskFixReport(deps, input, live.session.handle, input.commit);
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  if (deps.features.get(featureId)?.personId !== caller || deps.features.featureOfSession(sessionId) !== featureId) {
    return rejected("forbidden", `only the originating agent of feature ${featureId}'s plan reports its fixes`);
  }
  const grant = typeof input.part === "string" && typeof input.revision === "number" ? deps.grants.get(input.part, input.revision) : undefined;
  if (grant === undefined || grant.featureId !== featureId || grant.writer !== "agent") {
    return rejected("not_found", "no write was granted for that part and revision; ask fix_token first");
  }
  return recordFixWrite(deps, grant, live.session.handle, input.commit);
}

/** The check runner reports the commit it pushed for write `writeId`, which it claimed. */
export async function runnerFixReport(deps: FixWriteDeps, caller: BridgeCaller, writeId: number, body: unknown): Promise<FixWriteOutcome> {
  if (caller.role !== "runner") return rejected("forbidden", `bridge ${caller.bridgeId} does not hold the runner role`);
  const grant = deps.grants.byId(writeId);
  if (grant === undefined || grant.writer !== "runner") return rejected("not_found", `no write ${writeId}`);
  if (grant.claimedBy !== caller.bridgeId) return rejected("forbidden", `write ${writeId} is claimed by another runner`);
  const commit = typeof body === "object" && body !== null ? (body as { commit?: unknown }).commit : undefined;
  return recordFixWrite(deps, grant, RUNNER_WRITER, commit);
}

/**
 * Checks the commit a writer pushed for `grant` against the approved patch and keeps it as a signed
 * `fix_write` record; a commit that is not exactly the patch applied to the granted parent gets a
 * signed `fix_write_refused` record and is refused.
 */
async function recordFixWrite(deps: FixWriteDeps, grant: FixGrant, writtenBy: string, commit: unknown, holder?: string): Promise<FixWriteOutcome> {
  if (typeof commit !== "string" || !SHA.test(commit)) return rejected("invalid", "the commit must be a full 40-character SHA");
  if (grant.state === "written") return rejected("conflict", `revision ${grant.revision} of part ${grant.partId} is already written as ${grant.commitSha}`);
  if (grant.state !== "granted" || grant.parent === null) return rejected("conflict", `the write of part ${grant.partId} revision ${grant.revision} is not granted`);
  const approved = await grantedWrite(deps, grant);
  if (isRejection(approved)) {
    deps.grants.withdraw(grant.id);
    return rejected("conflict", `part ${grant.partId} moved on since the write was granted: ${approved.message}`);
  }
  if (grant.writer === "agent" && writtenBy !== approved.plan.proposedBy && writtenBy !== holder) {
    return rejected("forbidden", `the write was granted to ${approved.plan.proposedBy}, the originating agent, or the holder of its edit task`);
  }
  const files = checkedFiles(approved, await deps.scopeMap());
  if (isRejection(files)) return files;
  const partId = writtenPart(grant);
  const message = fixCommitMessage({
    partId,
    revision: grant.revision,
    target: approved.target.id,
    approvedBy: approved.part.approvedBy as string,
    writtenBy,
    ref: approved.part.diff.ref,
    ...(approved.copiedFrom === undefined ? {} : { copiedFrom: approved.copiedFrom }),
  });
  const parent = grant.parent;
  // The runner's commit also holds the copies Penguin worked out for this head, each at the checkpoint's bytes.
  let copies: ReadonlyMap<string, string> = new Map();
  if (grant.writer === "runner" && !isMigrationPlanId(grant.planId)) {
    const read = await copyFor(deps, approved as ApprovedPart, parent, files);
    if (read.status !== "ok") return rejected("conflict", read.message);
    copies = read.copy === null ? new Map() : new Map(read.copy.paths.map((path) => [path, read.hashes.get(path) as string]));
  }
  const problem = await deps.readFork(approved.target.repo, (reader) => commitProblem(reader, { commit, parent, message, files, copies }));
  const targetRepo = `feature-${approved.target.id}`;
  const fields = {
    plan_id: approved.plan.planId,
    part_id: partId,
    revision: grant.revision,
    target_repo: targetRepo,
    commit_sha: commit,
    parent,
    ...(copies.size === 0 ? {} : { copied: [...copies.keys()] }),
    ...(approved.copiedFrom === undefined ? {} : { copied_from: approved.copiedFrom }),
  };
  if (problem !== null) {
    const refused = await deps.sign(deps.features.draftRecord(grant.featureId, "fix_write_refused", { penguin: true }, { ...fields, written_by: writtenBy, reason: problem }));
    deps.features.addRecord(refused);
    return rejected("invalid", `Penguin did not keep commit ${commit}: ${problem}`);
  }
  const record = await deps.sign(
    deps.features.draftRecord(grant.featureId, "fix_write", grant.writer === "agent" ? { identity: writtenBy } : { penguin: true }, {
      ...fields,
      rebased: grant.rebased,
      diff: approved.part.diff.ref,
      kind: approved.part.kind,
      written_by: writtenBy,
    }),
  );
  const now = (deps.now ?? Date.now)();
  const write: FixWrite = {
    partId,
    revision: grant.revision,
    targetRepo,
    commitSha: commit,
    parent,
    recordId: record.record_id,
    writtenAt: new Date(now).toISOString(),
  };
  const migration = isMigrationPlanId(grant.planId) ? deps.migration : undefined;
  // A copy write is kept on its grant alone: the part's FixWrite row is its own write's.
  if (migration === undefined && approved.copiedFrom === undefined && !(await deps.keeper(grant.featureId).keepFixWrite(write))) {
    return rejected("conflict", `revision ${grant.revision} of part ${grant.partId} is already written`);
  }
  deps.features.addRecord(record);
  deps.grants.written(grant.id, commit, record.record_id, copies);
  await migration?.written(grant.partId, commit, record.record_id);
  deps.notify(approved.target.personId);
  deps.notify(approved.plan.person);
  // The fork moved: each write still waiting there is tried on the new head before its turn.
  await deps.written?.(grant, commit);
  return { status: "ok", write, durationMs: Math.max(0, now - grant.createdAt) };
}

/**
 * Why `commit` is not exactly the approved patch applied to `parent` as one commit on the fork's
 * `main` with `message`, or null when it is.
 */
export async function commitProblem(
  reader: ForkReader,
  expected: {
    readonly commit: string;
    readonly parent: string;
    readonly message: string;
    readonly files: readonly PlanFileDiff[];
    /** Each module copied from the originating checkpoint, with the blob it must hold. */
    readonly copies?: ReadonlyMap<string, string>;
  },
): Promise<string | null> {
  const { commit, parent, message, files } = expected;
  const copies = expected.copies ?? new Map<string, string>();
  const pushed = await reader.readCommit(commit);
  if (pushed === null) return `commit ${commit} is not in the fork`;
  if (pushed.parents.length !== 1 || pushed.parents[0] !== parent) {
    return `the commit's parents are ${pushed.parents.join(", ") || "none"}, not the granted fork head ${parent}`;
  }
  if (pushed.message.trim() !== message.trim()) return "the commit message is not the one Penguin built for the part";
  const base = await reader.readCommit(parent);
  if (base === null) return `the parent ${parent} is not in the fork`;
  const wanted = new Set([...files.map((file) => file.path), ...copies.keys()]);
  const changed = await changedFiles(reader, base.treeHash, pushed.treeHash);
  const outside = changed.find((file) => !wanted.has(file.path));
  if (outside !== undefined) return `the commit changes ${outside.path}, outside the approved part and the originating change's copied modules`;
  for (const [path, hash] of copies) {
    if (changed.find((file) => file.path === path)?.newHash !== hash) return `${path} is not the originating checkpoint's module, byte for byte`;
  }
  for (const file of files) {
    const applied = applyPatchFile(file, await readFileText(reader, base.treeHash, file.path));
    if (!applied.ok) return applied.message;
    if ((await readFileText(reader, pushed.treeHash, file.path)) !== applied.text) return `${file.path} is not the approved patch applied to the parent`;
  }
  const history = await reader.log({ ref: FIX_WRITE_BRANCH, limit: HEAD_SEARCH_LIMIT });
  if (!history.some((entry) => entry.hash === commit)) return `the commit is not on the fork's ${FIX_WRITE_BRANCH} branch`;
  return null;
}
