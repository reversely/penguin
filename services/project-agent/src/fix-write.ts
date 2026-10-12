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
//   only. No other session, identity or bridge gets a token on another person's fork here.
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
// - The record. The writer reports the commit. Penguin reads it through the Artifacts binding and keeps
//   it only when its one parent is the granted head, its message is the one built from the part's
//   validated fields (fixCommitMessage), it changes exactly the patch's files and each file is the
//   patch applied to the parent. The commit must also be on the fork's `main`. A kept write is a signed `fix_write` record
//   and a `FixWrite` row in the feature's plan store; a refused one is a signed `fix_write_refused`
//   record.

import {
  applyPatchFile,
  FIX_WRITE_BRANCH,
  fixCommitMessage,
  parsePatch,
  RUNNER_WRITER,
  type FixWriter,
  type FixWriteSpec,
  type Plan,
  type PlanFileDiff,
  type PlanPart,
} from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRejectReason } from "./feature-open.ts";
import { parseFeatureId, type Feature, type FeatureRecord, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
import type { PlanRouteStore } from "./plan-approval.ts";
import type { FixWrite, PlanKeeper } from "./plan-store.ts";
import { changedFiles, readFileText, type GitObjectReader } from "./repo-diff.ts";
import { notStopped, RUN_FAILURE_SCHEMA, type StoreRelease } from "./run-failures.ts";
import type { SessionOutcome } from "./session-store.ts";

type Row = Record<string, SqlValue>;

/** How long a runner's claim of a write holds before another claim may take it. */
export const FIX_WRITE_LEASE_MS = 10 * 60_000;

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
  readonly writer: FixWriter;
  readonly state: FixGrantState;
  readonly parent: string | null;
  readonly rebased: boolean;
  /** The runner bridge holding the claim, or null. */
  readonly claimedBy: string | null;
  readonly leaseUntil: number | null;
  readonly commitSha: string | null;
  readonly recordId: string | null;
  /** When the write was first asked for: the approval of a mechanical part, the first `fix_token` of a behavioural one. */
  readonly createdAt: number;
  readonly writtenAt: number | null;
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
    writer: row["writer"] as FixWriter,
    state: row["state"] as FixGrantState,
    parent: nullable("parent"),
    rebased: Number(row["rebased"]) === 1,
    claimedBy: nullable("claimed_by"),
    leaseUntil: number("lease_until"),
    commitSha: nullable("commit_sha"),
    recordId: nullable("record_id"),
    createdAt: Number(row["created_at"]),
    writtenAt: number("written_at"),
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
  }

  /** The write of one revision of a part, made `queued` for `writer` when there is none yet. */
  open(featureId: string, planId: string, part: PlanPart, target: string, writer: FixWriter): FixGrant {
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

  written(id: number, commit: string, recordId: string): void {
    this.#db.exec(`UPDATE FixWriteGrant SET state = 'written', commit_sha = ?, record_id = ?, written_at = ? WHERE id = ?`, commit, recordId, this.#now(), id);
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
}

export type FixRejectReason = FeatureRejectReason | "not_approved" | "head_moved";

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

interface ApprovedPart {
  readonly featureId: string;
  readonly plan: Plan;
  readonly part: PlanPart & { readonly place: { readonly kind: "feature"; readonly feature: string } };
  readonly patch: string;
  readonly base: string;
  readonly target: Feature & { readonly repo: string };
}

const isRejection = (value: unknown): value is FixRejection =>
  typeof value === "object" && value !== null && (value as { status?: unknown }).status === "rejected";

/**
 * The current revision of an approved part on a running feature in the feature's newest plan, or why
 * no fix may be written for it.
 */
async function approvedPart(deps: FixWriteDeps, input: FixPartInput): Promise<ApprovedPart | FixRejection> {
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
  if (part.diff.source !== "patch" || part.diff.patch === null || part.diff.base === null) {
    return rejected("invalid", `part ${partId} carries no patch to write`);
  }
  const target = deps.features.get(part.place.feature);
  if (target?.repo == null) return rejected("not_found", `feature ${part.place.feature} has no fork`);
  // A landed fork is read-only (PRD 4.5 step 5): no fix goes into it, and a landed plan writes none.
  for (const feature of [target, deps.features.get(featureId)]) {
    if (feature?.state === "landed") return rejected("conflict", `feature ${feature.id} has landed; its fork is read-only`);
  }
  return {
    featureId,
    plan,
    part: part as ApprovedPart["part"],
    patch: part.diff.patch,
    base: part.diff.base,
    target: target as ApprovedPart["target"],
  };
}

/** The fork's head on its `main`, or null when the branch has no commit. */
async function forkHead(deps: FixWriteDeps, repo: string): Promise<string | null> {
  const [head] = await deps.readFork(repo, (reader) => reader.log({ ref: FIX_WRITE_BRANCH, limit: 1 }));
  return head?.hash ?? null;
}

/** The patch's files, each checked to lie inside the part's scopes and in its approved diff. */
function checkedFiles(approved: ApprovedPart, scopeMap: ScopeMap): PlanFileDiff[] | FixRejection {
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
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const next: PlanPart = {
    ...part,
    approvalState: "change_requested",
    approvedBy: null,
    changeRequest: {
      by: "penguin",
      revision: part.revision,
      text: `Feature ${part.place.feature}'s fork moved from ${approved.base} to ${head} and the approved patch no longer applies there (${problem}). Revise the part as a patch against ${head}.`,
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
async function prepare(deps: FixWriteDeps, approved: ApprovedPart, grant: FixGrant, writtenBy: string): Promise<FixGrantOutcome> {
  const { plan, part, target } = approved;
  const files = checkedFiles(approved, await deps.scopeMap());
  if (isRejection(files)) return files;
  const head = await forkHead(deps, target.repo);
  if (head === null) return rejected("not_found", `feature ${target.id}'s fork has no ${FIX_WRITE_BRANCH} branch`);
  let parent = approved.base;
  if (head !== approved.base) {
    const problem = await applyProblem(deps, target.repo, head, files);
    if (problem !== null) {
      await sendBack(deps, approved, head, problem);
      return rejected("head_moved", `feature ${target.id}'s fork moved to ${head} and the patch no longer applies there; part ${part.partId} went back to the originating agent to revise`);
    }
    parent = head;
  }
  const spec: FixWriteSpec = {
    writeId: grant.id,
    feature: approved.featureId,
    planId: plan.planId,
    partId: part.partId,
    revision: part.revision,
    kind: part.kind,
    writer: grant.writer,
    target: target.id,
    fork: `feature-${target.id}`,
    branch: FIX_WRITE_BRANCH,
    parent,
    rebased: parent !== approved.base,
    paths: files.map((file) => file.path),
    patch: approved.patch,
    message: fixCommitMessage({
      partId: part.partId,
      revision: part.revision,
      target: target.id,
      approvedBy: part.approvedBy as string,
      writtenBy,
      ref: part.diff.ref,
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
  if (approved.part.kind === "mechanical") {
    return rejected("forbidden", `part ${approved.part.partId} is mechanical: Penguin's check runner writes it`);
  }
  const grant = deps.grants.open(featureId, approved.plan.planId, approved.part, approved.target.id, "agent");
  if (grant.state === "written") {
    return rejected("conflict", `revision ${grant.revision} of part ${grant.partId} is already written as ${grant.commitSha}`);
  }
  const prepared = await prepare(deps, approved, grant, approved.plan.proposedBy);
  if (prepared.status === "ok") deps.grants.grant(grant.id, prepared.spec.parent, prepared.spec.rebased, null, null);
  else if (prepared.reason === "head_moved") deps.grants.withdraw(grant.id);
  return prepared;
}

/** On an approval: queues the check runner's write of a mechanical part on a running feature. */
export function queueRunnerWrite(grants: FixGrantStore, featureId: string, plan: Plan, part: PlanPart): void {
  if (part.place.kind !== "feature" || part.kind !== "mechanical" || part.approvalState !== "approved") return;
  grants.open(featureId, plan.planId, part, part.place.feature, "runner");
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
    const approved = await approvedPart(deps, { feature: grant.featureId, part: grant.partId, revision: grant.revision });
    if (isRejection(approved) || approved.part.kind !== "mechanical") {
      deps.grants.withdraw(grant.id);
      continue;
    }
    const prepared = await prepare(deps, approved, grant, RUNNER_WRITER);
    if (prepared.status !== "ok") {
      // A moved head sent the part back for revision; anything else stays queued for the next claim.
      if (prepared.reason === "head_moved") deps.grants.withdraw(grant.id);
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
async function recordFixWrite(deps: FixWriteDeps, grant: FixGrant, writtenBy: string, commit: unknown): Promise<FixWriteOutcome> {
  if (typeof commit !== "string" || !SHA.test(commit)) return rejected("invalid", "the commit must be a full 40-character SHA");
  if (grant.state === "written") return rejected("conflict", `revision ${grant.revision} of part ${grant.partId} is already written as ${grant.commitSha}`);
  if (grant.state !== "granted" || grant.parent === null) return rejected("conflict", `the write of part ${grant.partId} revision ${grant.revision} is not granted`);
  const approved = await approvedPart(deps, { feature: grant.featureId, part: grant.partId, revision: grant.revision });
  if (isRejection(approved)) {
    deps.grants.withdraw(grant.id);
    return rejected("conflict", `part ${grant.partId} moved on since the write was granted: ${approved.message}`);
  }
  if (grant.writer === "agent" && writtenBy !== approved.plan.proposedBy) {
    return rejected("forbidden", `the write was granted to ${approved.plan.proposedBy}, the originating agent`);
  }
  const files = checkedFiles(approved, await deps.scopeMap());
  if (isRejection(files)) return files;
  const message = fixCommitMessage({
    partId: grant.partId,
    revision: grant.revision,
    target: approved.target.id,
    approvedBy: approved.part.approvedBy as string,
    writtenBy,
    ref: approved.part.diff.ref,
  });
  const parent = grant.parent;
  const problem = await deps.readFork(approved.target.repo, (reader) => commitProblem(reader, { commit, parent, message, files }));
  const targetRepo = `feature-${approved.target.id}`;
  const fields = { plan_id: approved.plan.planId, part_id: grant.partId, revision: grant.revision, target_repo: targetRepo, commit_sha: commit, parent };
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
    partId: grant.partId,
    revision: grant.revision,
    targetRepo,
    commitSha: commit,
    parent,
    recordId: record.record_id,
    writtenAt: new Date(now).toISOString(),
  };
  if (!(await deps.keeper(grant.featureId).keepFixWrite(write))) {
    return rejected("conflict", `revision ${grant.revision} of part ${grant.partId} is already written`);
  }
  deps.features.addRecord(record);
  deps.grants.written(grant.id, commit, record.record_id);
  deps.notify(approved.target.personId);
  deps.notify(approved.plan.person);
  return { status: "ok", write, durationMs: Math.max(0, now - grant.createdAt) };
}

/**
 * Why `commit` is not exactly the approved patch applied to `parent` as one commit on the fork's
 * `main` with `message`, or null when it is.
 */
export async function commitProblem(
  reader: ForkReader,
  expected: { readonly commit: string; readonly parent: string; readonly message: string; readonly files: readonly PlanFileDiff[] },
): Promise<string | null> {
  const { commit, parent, message, files } = expected;
  const pushed = await reader.readCommit(commit);
  if (pushed === null) return `commit ${commit} is not in the fork`;
  if (pushed.parents.length !== 1 || pushed.parents[0] !== parent) {
    return `the commit's parents are ${pushed.parents.join(", ") || "none"}, not the granted fork head ${parent}`;
  }
  if (pushed.message.trim() !== message.trim()) return "the commit message is not the one Penguin built for the part";
  const base = await reader.readCommit(parent);
  if (base === null) return `the parent ${parent} is not in the fork`;
  const wanted = new Set(files.map((file) => file.path));
  const changed = await changedFiles(reader, base.treeHash, pushed.treeHash);
  const outside = changed.find((file) => !wanted.has(file.path));
  if (outside !== undefined) return `the commit changes ${outside.path}, outside the approved part`;
  for (const file of files) {
    const applied = applyPatchFile(file, await readFileText(reader, base.treeHash, file.path));
    if (!applied.ok) return applied.message;
    if ((await readFileText(reader, pushed.treeHash, file.path)) !== applied.text) return `${file.path} is not the approved patch applied to the parent`;
  }
  const history = await reader.log({ ref: FIX_WRITE_BRANCH, limit: HEAD_SEARCH_LIMIT });
  if (!history.some((entry) => entry.hash === commit)) return `the commit is not on the fork's ${FIX_WRITE_BRANCH} branch`;
  return null;
}
