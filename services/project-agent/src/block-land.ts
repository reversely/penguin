// Landing a feature as a block (PRD 0.4 section 4.5).
//
// 1. The originating agent asks to land (`land_feature`). The ProjectAgent checks the feature is
//    ready: its latest checkpoint is in its fork and already contains main's head (the agent took
//    main), every part of its plan is approved, every person whose protected path the feature's own
//    change touches confirmed its lines (protected-change.ts), each fix for a running feature is
//    written into that feature's fork (fix-write.ts) and still sits under the fork's head, and each
//    fix for code on main is in the checkpoint. It then asks the feature's FeatureAgent to open a block run: the
//    checkpoint merged onto main and onto every other running feature's fork head. The feature is
//    `landing` and a signed `land_requested` record names the run.
// 2. The check runner claims the run (POST /blocks/claim) and runs the checks of section 5.1 on every
//    merged tree, with every scope's tests on main's (block-run.ts on the bridge). It reports to the
//    FeatureAgent directly (POST /blocks/<run id>). Each failure carries its one next step from the
//    resolution ladder (section 5.3); the feature goes back to `building` and the agent lands again.
//    Each step an agent takes becomes an edit task routed by charter (edit-work.ts `blockReported`).
// 3. When every check passes, the FeatureAgent promotes: it takes the project's one promotion slot,
//    and moves main from the commit the block was checked against to the checkpoint in one push
//    (main-push.ts), with a write token on main that it mints for minutes and revokes after the push.
//    Main that moved since the check refuses the push; the land is checked again on the new main, or
//    returned to the agent to take main first. A promotion is a signed `promotion` record and a
//    `Promotion` row; the originating fork's write tokens are revoked and no new one is minted.
//
// A checkpoint of a running feature that reaches an announced plan's area asks for a `plan_check` of
// that plan's block (PRD 4.4 step 3): the same checks, with no promotion.
//
// An `expand` run (expand-promotion.ts, PRD 4.2 step 2 and 4.5 step 6) checks and promotes a checkpoint
// that only adds through the same steps, but the feature stays `building`: its fork keeps its write
// tokens, the promotion is a signed `expand_promotion` record, and a race is checked again as an expand.
//
// Because main moves only by fast-forward to a commit the block was checked on, main's tree after a
// promotion is exactly the tree whose tests passed: main is never red unless a check missed a break.

import {
  blockVerdict,
  FIX_WRITE_BRANCH,
  parseBlockRunReport,
  type Author,
  type BlockRunTarget,
  type CallerReplaySection,
  type CharterView,
  type LadderDecision,
  type Plan,
  type Promotion,
} from "@penguin/protocol";

import type { BlockOpenOutcome, BlockRun, BlockRunInput, BlockRunState, BlockStore } from "./block-store.ts";
import type { FeatureRejectReason } from "./feature-open.ts";
import { parseFeatureId, readOnlyReason, type Feature, type FeatureRecord, type FeatureRecordType, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import type { ForkReader, ForkReading } from "./fix-write.ts";
import type { BridgeCaller, SqlDatabase } from "./issue-index.ts";
import type { FastForwardOutcome } from "./main-push.ts";
import type { FixWrite } from "./plan-store.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";
import type { SessionOutcome } from "./session-store.ts";

/** Penguin's write token on main lasts this many minutes unless PENGUIN_PROMOTION_TOKEN_TTL_MINUTES says otherwise. */
export const PROMOTION_TOKEN_TTL_DEFAULT_MINUTES = 5;
/** PRD 0.4 section 8: Penguin holds write on main for minutes only. */
export const PROMOTION_TOKEN_TTL_MAX_MINUTES = 15;

/**
 * Parses PENGUIN_PROMOTION_TOKEN_TTL_MINUTES into seconds. Unset is the default; a whole number of
 * minutes from 1 to the maximum is taken; anything else is undefined, so no promotion runs.
 */
export function parsePromotionTokenTtl(minutes: string | undefined): number | undefined {
  if (minutes === undefined || minutes === "") return PROMOTION_TOKEN_TTL_DEFAULT_MINUTES * 60;
  if (!/^[1-9][0-9]?$/u.test(minutes)) return undefined;
  const value = Number(minutes);
  return value <= PROMOTION_TOKEN_TTL_MAX_MINUTES ? value * 60 : undefined;
}

/** Commits of main's first-parent history read to bound an ancestry search. */
const MAIN_HISTORY_LIMIT = 1_000;
/** Commits an ancestry search visits before it gives up. */
const ANCESTRY_LIMIT = 2_000;
/** A promotion holds the project's slot at most this long. */
export const PROMOTION_SLOT_MS = 10 * 60_000;

export const BLOCK_QUEUE_SCHEMA: readonly string[] = [
  // The features whose FeatureAgent holds a run waiting for the check runner.
  `CREATE TABLE IF NOT EXISTS BlockQueue (feature_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)`,
  // The project's one promotion in progress: only one push moves main at a time.
  `CREATE TABLE IF NOT EXISTS PromotionSlot (slot INTEGER PRIMARY KEY CHECK (slot = 1), feature_id TEXT NOT NULL,
    run_id TEXT NOT NULL, until INTEGER NOT NULL)`,
];

/** The ProjectAgent's side of landing: which FeatureAgents hold waiting runs, and the promotion slot. */
export class BlockQueueStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of BLOCK_QUEUE_SCHEMA) db.exec(statement);
  }

  add(featureId: string): void {
    this.#db.exec(`INSERT OR IGNORE INTO BlockQueue (feature_id, queued_at) VALUES (?, ?)`, featureId, this.#now());
  }

  remove(featureId: string): void {
    this.#db.exec(`DELETE FROM BlockQueue WHERE feature_id = ?`, featureId);
  }

  queued(): string[] {
    return this.#db.exec(`SELECT feature_id FROM BlockQueue ORDER BY queued_at, feature_id`).map((row) => row["feature_id"] as string);
  }

  /** Takes the promotion slot for `runId`; false while another run holds it and its time has not run out. */
  acquire(featureId: string, runId: string, holdMs = PROMOTION_SLOT_MS): boolean {
    const now = this.#now();
    const taken = this.#db.exec(
      `INSERT INTO PromotionSlot (slot, feature_id, run_id, until) VALUES (1, ?, ?, ?)
       ON CONFLICT (slot) DO UPDATE SET feature_id = excluded.feature_id, run_id = excluded.run_id, until = excluded.until
       WHERE PromotionSlot.until < ? OR PromotionSlot.run_id = excluded.run_id
       RETURNING run_id`,
      featureId,
      runId,
      now + holdMs,
      now,
    );
    return taken.length > 0;
  }

  release(runId: string): void {
    this.#db.exec(`DELETE FROM PromotionSlot WHERE run_id = ?`, runId);
  }
}

/** What the ProjectAgent asks of a feature's FeatureAgent about its block, over Durable Object RPC. */
export interface FeatureBlocks {
  latestPlan(featureId: string): Plan | undefined | Promise<Plan | undefined>;
  fixWrites(featureId: string): FixWrite[] | Promise<FixWrite[]>;
  openBlockRun(input: BlockRunInput): BlockOpenOutcome | Promise<BlockOpenOutcome>;
  /** Hands the runner the feature's waiting runs; `waiting` stays true while any run still waits. */
  claimBlockRuns(runnerId: string): { readonly runs: readonly BlockRun["request"][]; readonly waiting: boolean } | Promise<{ readonly runs: readonly BlockRun["request"][]; readonly waiting: boolean }>;
  /** Frees a run `runnerId` claimed and failed (run-failures.ts); see BlockStore.release. */
  releaseBlockRun?(runnerId: string, runId: string): ReturnType<BlockStore["release"]> | Promise<ReturnType<BlockStore["release"]>>;
  /** Fails a run past the failure limit; its purpose, or undefined when it no longer waits. */
  stopBlockRun?(runId: string, reason: string): BlockRun["purpose"] | undefined | Promise<BlockRun["purpose"] | undefined>;
}

export type LandRejectReason =
  | FeatureRejectReason
  | "not_ready"
  | "behind_main"
  | "plan_not_approved"
  | "protected_path_unconfirmed"
  | "fix_not_written"
  | "fix_not_in_block"
  | "fix_not_in_place"
  | "copy_not_written"
  | "callers_pending"
  | "busy"
  // An expand checkpoint (expand-promotion.ts): the impact run is not reported, failed, finds more
  // than additions, or an owner of a scope it adds to has not approved yet.
  | "waiting_for_runner"
  | "impact_failed"
  | "not_only_adds"
  | "waiting_on_owner";

export type LandRejection = { readonly status: "rejected"; readonly reason: LandRejectReason; readonly message: string };

export type LandOutcome = { readonly status: "checking"; readonly run: BlockRun; readonly recordId: string } | LandRejection;

export interface LandDeps {
  readonly features: FeatureStore;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  /** The charter of an identity, by its handle, which routes the block's failures (resolution.ts). */
  readonly charter: (handle: string, featurePerson: string) => CharterView | undefined;
  readonly agent: (featureId: string) => FeatureBlocks;
  /** Reads an Artifacts repo, named with the deployment's prefix, through the binding. */
  readonly readRepo: ForkReading;
  /** The base repo's Artifacts name, with the prefix. */
  readonly baseRepo: string;
  /** Main's branch: BASE_BRANCH. */
  readonly branch: string;
  readonly queue: BlockQueueStore;
  /**
   * The people whose protected paths the feature's own change touches and who have not confirmed its
   * lines at the latest checkpoint (protected-change.ts). Absent, no land waits on a confirmation.
   */
  readonly unconfirmedProtected?: (featureId: string) => readonly { readonly ownerId: string; readonly files: readonly { readonly protectedPath: string }[] }[];
  /**
   * Each affected fork in `targets` that does not yet hold the plan's current revision of the
   * originating change's modules it imports, with why (fix-write.ts `copiesBehind`). Absent, no land
   * waits on a copy.
   */
  readonly copiesBehind?: (plan: Plan, targets: readonly BlockRunTarget[]) => Promise<readonly string[]>;
  /**
   * Each caller item of the feature's replays that is not yet confirmed, written or approved, as one
   * line (caller-items.ts `landPending`). Absent, no land waits on a caller.
   */
  readonly callersPending?: (featureId: string) => Promise<readonly string[]>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  readonly notify: (personId: string) => void;
  readonly now?: () => number;
}

export interface LandInput {
  readonly feature: unknown;
  /** The checkpoint the agent means to land; when given, it must be the feature's latest. */
  readonly checkpoint?: unknown;
}

const rejected = (reason: LandRejectReason, message: string): LandRejection => ({ status: "rejected", reason, message });
const isRejection = (value: unknown): value is LandRejection =>
  typeof value === "object" && value !== null && (value as { status?: unknown }).status === "rejected";
const SHA = /^[0-9a-f]{40}$/u;
const short = (sha: string): string => sha.slice(0, 12);

/**
 * Which of `wanted` are `from` or among its ancestors in `reader`'s repo. The search stops below any
 * commit of main's history other than those wanted: everything under main's head is main's own, so a
 * fork's search stays among the fork's commits since it last took main.
 */
export async function ancestorsFound(reader: ForkReader, from: string, wanted: ReadonlySet<string>, mainHistory: ReadonlySet<string>): Promise<Set<string>> {
  const found = new Set<string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0 && found.size < wanted.size && seen.size <= ANCESTRY_LIMIT) {
    const hash = queue.shift() as string;
    if (wanted.has(hash)) found.add(hash);
    if (mainHistory.has(hash) && hash !== from) continue;
    const commit = await reader.readCommit(hash);
    for (const parent of commit?.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  return found;
}

/** Main's head and the first-parent history under it, read from the base repo. */
export async function mainState(deps: LandDeps): Promise<{ readonly head: string | null; readonly history: Set<string> }> {
  const log = await deps.readRepo(deps.baseRepo, (reader) => reader.log({ ref: deps.branch, limit: MAIN_HISTORY_LIMIT }));
  return { head: log[0]?.hash ?? null, history: new Set(log.map((entry) => entry.hash)) };
}

/** The head of a fork's main branch, where its feature's work and every fix written into it sit. */
async function forkHead(deps: Pick<LandDeps, "readRepo">, repo: string): Promise<string | null> {
  const [head] = await deps.readRepo(repo, (reader) => reader.log({ ref: FIX_WRITE_BRANCH, limit: 1 }));
  return head?.hash ?? null;
}

/**
 * Every other running feature's fork head, in feature id order: the block's targets besides main. A
 * fork head holds every fix written into the fork; a fork with no head yet counts at its latest
 * checkpoint. `check` merges onto the same targets (agent-tool-runner.ts), so check and land agree.
 */
export async function blockTargets(deps: Pick<LandDeps, "features" | "readRepo">, own: string): Promise<BlockRunTarget[]> {
  const running = deps.features
    .list()
    .filter((feature) => feature.id !== own && RUNNING_STATES.has(feature.state) && feature.repo !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const heads = await Promise.all(running.map(async (feature) => (await forkHead(deps, feature.repo as string)) ?? feature.latestCheckpointSha));
  return running.flatMap((feature, index) => {
    const sha = heads[index];
    return sha == null ? [] : [{ feature: feature.id, person: feature.personId, fork: `feature-${feature.id}`, sha }];
  });
}

/**
 * Why the feature may not reach main while a person whose protected path its own change touches has
 * not confirmed the lines (protected-change.ts); undefined when none waits. A land and an expand both ask.
 */
export function protectedRefusal(deps: Pick<LandDeps, "unconfirmedProtected">, featureId: string): LandRejection | undefined {
  const unconfirmed = deps.unconfirmedProtected?.(featureId) ?? [];
  if (unconfirmed.length === 0) return undefined;
  // Each person is named with the protected paths of penguin/scopes.json, never the fork's file names.
  const list = unconfirmed.map(({ ownerId, files }) => `${ownerId} (${[...new Set(files.map((file) => file.protectedPath))].join(", ")})`).join("; ");
  return rejected(
    "protected_path_unconfirmed",
    `the feature's own change touches paths under other people's custom path rules; each confirms the lines on the dashboard before it reaches main: ${list}`,
  );
}

interface Prepared {
  readonly feature: Feature & { readonly repo: string; readonly latestCheckpointSha: string };
  readonly plan: Plan | undefined;
  readonly mainBefore: string;
  readonly targets: readonly BlockRunTarget[];
}

/**
 * The facts a land needs, or why the feature may not land yet: main's head, which the checkpoint must
 * contain; the plan, every part approved and every fix in place; and the targets.
 */
async function prepareLand(deps: LandDeps, feature: Feature, checkpoint: unknown): Promise<Prepared | LandRejection> {
  const readOnly = readOnlyReason(feature);
  if (readOnly !== undefined) return rejected("conflict", readOnly);
  if (feature.repo === null) return rejected("not_found", `feature ${feature.id} has no fork yet`);
  const latest = feature.latestCheckpointSha;
  if (latest === null) return rejected("not_ready", `feature ${feature.id} has no checkpoint; report one with report_checkpoint first`);
  if (checkpoint !== undefined && checkpoint !== latest) {
    return rejected("conflict", `the feature's latest checkpoint is ${latest}; report the commit you mean to land as a checkpoint first`);
  }
  const main = await mainState(deps);
  if (main.head === null) return rejected("not_found", `main's ${deps.branch} branch has no commit`);
  if (main.head === latest) return rejected("not_ready", `main is already at ${short(latest)}; nothing to land`);

  const plan = await deps.agent(feature.id).latestPlan(feature.id);
  const unapproved = plan?.parts.filter((part) => part.approvalState !== "approved") ?? [];
  if (unapproved.length > 0) {
    const list = unapproved.map((part) => `${part.partId} (${part.approvalState.replaceAll("_", " ")})`).join(", ");
    return rejected("plan_not_approved", `every part of plan ${plan?.planId} must be approved before it lands: ${list}`);
  }
  const unconfirmed = protectedRefusal(deps, feature.id);
  if (unconfirmed !== undefined) return unconfirmed;
  const writes = plan === undefined ? [] : await deps.agent(feature.id).fixWrites(feature.id);
  const written = new Map(writes.map((write) => [`${write.partId}@${write.revision}`, write]));
  // A verify part has no fix, so nothing is written into its fork.
  const featureParts = plan?.parts.filter((part) => part.place.kind === "feature" && part.kind !== "verify") ?? [];
  const unwritten = featureParts.filter((part) => !written.has(`${part.partId}@${part.revision}`));
  if (unwritten.length > 0) {
    return rejected("fix_not_written", `the fixes of ${unwritten.map((part) => part.partId).join(", ")} are approved but not yet written into their forks; write each with fix_token and report_fix_write`);
  }

  // The checkpoint must hold main's head and every fix for code on main.
  const scopeFixes = new Set(plan?.parts.flatMap((part) => (part.place.kind === "scope" && part.diff.commit !== null ? [part.diff.commit] : [])) ?? []);
  const inBlock = await deps.readRepo(feature.repo, (reader) => ancestorsFound(reader, latest, new Set([main.head as string, ...scopeFixes]), main.history));
  if (!inBlock.has(main.head)) {
    return rejected(
      "behind_main",
      `main moved to ${main.head} since checkpoint ${short(latest)} was built; merge main into your fork, report the merge as a checkpoint and land again`,
    );
  }
  const missingFix = [...scopeFixes].filter((commit) => !inBlock.has(commit));
  if (missingFix.length > 0) {
    return rejected("fix_not_in_block", `the fixes for code on main ${missingFix.map(short).join(", ")} are not in checkpoint ${short(latest)}`);
  }

  const targets = await blockTargets(deps, feature.id);
  for (const part of featureParts) {
    if (part.place.kind !== "feature") continue;
    const write = written.get(`${part.partId}@${part.revision}`) as FixWrite;
    const target = targets.find((each) => each.feature === (part.place as { feature: string }).feature);
    if (target === undefined) continue; // The affected feature landed or stopped: it takes main like anyone.
    const repo = deps.features.get(target.feature)?.repo as string;
    const found = await deps.readRepo(repo, (reader) => ancestorsFound(reader, target.sha, new Set([write.commitSha]), main.history));
    if (!found.has(write.commitSha)) {
      return rejected("fix_not_in_place", `fix ${short(write.commitSha)} of ${part.partId} is no longer under feature ${target.feature}'s fork head ${short(target.sha)}`);
    }
  }
  // Each affected fork holds the plan's current revision of the modules it imports, so the copies and
  // the change are checked and land as one block.
  const behind = plan === undefined ? [] : ((await deps.copiesBehind?.(plan, targets)) ?? []);
  if (behind.length > 0) {
    return rejected("copy_not_written", `the affected forks do not yet hold the originating change's current modules; Penguin's check runner copies them first: ${behind.join("; ")}`);
  }
  const callers = (await deps.callersPending?.(feature.id)) ?? [];
  if (callers.length > 0) return rejected("callers_pending", callersPendingMessage(callers));
  return { feature: feature as Prepared["feature"], plan, mainBefore: main.head, targets };
}

/** Why a feature may not reach main while caller items wait, naming each. */
function callersPendingMessage(callers: readonly string[]): string {
  return `every affected caller must be confirmed, its fix written or its difference approved first; read each in get_work's callerItems: ${callers.slice(0, 20).join("; ")}`;
}

export function targetFields(targets: readonly BlockRunTarget[]): Record<string, unknown>[] {
  return targets.map(({ feature, sha }) => ({ feature, sha }));
}

/**
 * The caller replay as the signed `block_checked` record keeps it: each replay run's commits and each
 * caller's verdict with the ids of its differing calls, which a later confirmation, explanation or
 * review cites. The recorded values stay in the run's stored report.
 */
export function callerReplayFields(section: CallerReplaySection | undefined): Record<string, unknown> {
  if (section === undefined) return {};
  return {
    caller_replay: {
      runs: section.runs.map((run) => ({ run_id: run.runId, feature: run.feature, fork_commit: run.forkCommit, merged_commit: run.mergedCommit })),
      callers: section.callers.map((caller) => ({
        run_id: caller.runId,
        feature: caller.feature,
        contract: caller.contract,
        path: caller.path,
        line: caller.line,
        verdict: caller.verdict,
        calls: caller.calls,
        differing: caller.differing.map((call) => call.callId),
        differing_count: caller.differingCount,
      })),
    },
  };
}

/** Opens the land run of a prepared feature and records the request; the feature is then `landing`. */
async function openLand(deps: LandDeps, prepared: Prepared, charter: CharterView, author: Author, requestedBy: string): Promise<LandOutcome> {
  const { feature, plan, mainBefore, targets } = prepared;
  const opened = await deps.agent(feature.id).openBlockRun({
    featureId: feature.id,
    planId: plan?.planId ?? null,
    purpose: "land",
    fork: `feature-${feature.id}`,
    checkpoint: feature.latestCheckpointSha,
    mainBefore,
    branch: deps.branch,
    targets,
    charter,
    requestedBy,
  });
  if (opened.status === "busy") return rejected("busy", `feature ${feature.id} is already landing (run ${opened.run.runId}, ${opened.run.state})`);
  const record = await deps.sign(
    deps.features.draftRecord(feature.id, "land_requested", author, {
      run_id: opened.run.runId,
      plan_id: plan?.planId ?? null,
      checkpoint: feature.latestCheckpointSha,
      main_before: mainBefore,
      branch: deps.branch,
      targets: targetFields(targets),
      superseded: [...opened.superseded],
    }),
  );
  deps.features.addRecord(record);
  deps.features.setState(feature.id, ["building", "landing"], "landing");
  deps.queue.add(feature.id);
  deps.notify(feature.personId);
  return { status: "checking", run: opened.run, recordId: record.record_id };
}

/**
 * `land_feature`: `caller`'s session asks to land the feature it works on. Refused unless the feature
 * is ready (see the module comment); otherwise the block run waits for the check runner.
 */
export async function requestLand(deps: LandDeps, caller: string, sessionId: string, input: LandInput): Promise<LandOutcome> {
  const id = parseFeatureId(input.feature);
  if (id === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  if (input.checkpoint !== undefined && (typeof input.checkpoint !== "string" || !SHA.test(input.checkpoint))) {
    return rejected("invalid", "the checkpoint must be a full 40-character lowercase SHA");
  }
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const feature = deps.features.get(id);
  if (feature === undefined) return rejected("not_found", `no feature has id ${id}`);
  if (feature.personId !== caller || deps.features.featureOfSession(sessionId) !== id) {
    return rejected("forbidden", `only an agent session of feature ${id} lands it`);
  }
  const charter = deps.charter(live.session.handle, feature.personId);
  if (charter === undefined) return rejected("not_found", `identity ${live.session.handle} has no charter`);
  const prepared = await prepareLand(deps, feature, input.checkpoint);
  if (isRejection(prepared)) return prepared;
  return openLand(deps, prepared, charter, { identity: live.session.handle }, live.session.handle);
}

/**
 * Penguin lands a feature it opened from main once every part it carries is written (penguin-land.ts):
 * the same readiness checks and block run as `land_feature`, with no session. `charter` is the
 * steward's of the feature's person, the DRI it works for, so the ladder routes failures to that steward.
 */
export async function requestPenguinLand(deps: LandDeps, featureId: string, charter: CharterView): Promise<LandOutcome> {
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature has id ${featureId}`);
  const prepared = await prepareLand(deps, feature, undefined);
  if (isRejection(prepared)) return prepared;
  return openLand(deps, prepared, charter, { penguin: true }, "penguin");
}

/**
 * Penguin lands the feature again after a promotion main refused (a race): the same checks on main's
 * new head. When the feature may no longer land as it is (most often because main moved past its
 * checkpoint), the feature goes back to `building` with a signed `land_returned` record.
 */
export async function retryLand(deps: LandDeps, featureId: string, previous: { readonly runId: string; readonly charter: CharterView }): Promise<LandOutcome> {
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature has id ${featureId}`);
  const prepared = await prepareLand(deps, feature, undefined);
  if (!isRejection(prepared)) return openLand(deps, prepared, previous.charter, { penguin: true }, "penguin");
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "land_returned", { penguin: true }, { run_id: previous.runId, reason: prepared.reason, message: prepared.message }),
  );
  deps.features.addRecord(record);
  deps.features.setState(featureId, ["landing"], "building");
  deps.notify(feature.personId);
  return prepared;
}

/**
 * A plan check (PRD 4.4 step 3): the block of `featureId`'s announced plan, checked at its latest
 * checkpoint on main's head and every running feature's fork head. Never promotes. Undefined when the
 * feature has no checkpoint, plan or charter, or a land run already holds it.
 */
export async function requestPlanCheck(deps: LandDeps, featureId: string, trigger: { readonly feature: string; readonly checkpoint: string }): Promise<BlockRun | undefined> {
  const feature = deps.features.get(featureId);
  if (feature === undefined || !RUNNING_STATES.has(feature.state) || feature.repo === null || feature.latestCheckpointSha === null) return undefined;
  const plan = await deps.agent(featureId).latestPlan(featureId);
  if (plan === undefined) return undefined;
  const charter = deps.charter(plan.proposedBy, feature.personId);
  const main = await mainState(deps);
  if (charter === undefined || main.head === null) return undefined;
  const targets = await blockTargets(deps, featureId);
  const opened = await deps.agent(featureId).openBlockRun({
    featureId,
    planId: plan.planId,
    purpose: "plan_check",
    fork: `feature-${featureId}`,
    checkpoint: feature.latestCheckpointSha,
    mainBefore: main.head,
    branch: deps.branch,
    targets,
    charter,
    requestedBy: "penguin",
  });
  if (opened.status === "busy") return undefined;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "plan_check_requested", { penguin: true }, {
      run_id: opened.run.runId,
      plan_id: plan.planId,
      checkpoint: feature.latestCheckpointSha,
      main_before: main.head,
      targets: targetFields(targets),
      trigger: { feature: trigger.feature, checkpoint: trigger.checkpoint },
    }),
  );
  deps.features.addRecord(record);
  deps.queue.add(featureId);
  return opened.run;
}

/** The runner's claim across every FeatureAgent that holds a waiting run. */
export async function claimBlockRuns(
  queue: BlockQueueStore,
  agent: (featureId: string) => FeatureBlocks,
  caller: BridgeCaller,
): Promise<{ readonly status: "ok"; readonly runs: readonly BlockRun["request"][] } | { readonly status: "forbidden"; readonly message: string }> {
  if (caller.role !== "runner") return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
  const runs: BlockRun["request"][] = [];
  for (const featureId of queue.queued()) {
    const claimed = await agent(featureId).claimBlockRuns(caller.bridgeId);
    runs.push(...claimed.runs);
    if (!claimed.waiting) queue.remove(featureId);
  }
  return { status: "ok", runs };
}

// The FeatureAgent's side: the runner's report, then the promotion.

/** The record types a FeatureAgent may ask the ProjectAgent to sign for its feature. */
export const BLOCK_RECORD_TYPES = ["block_checked", "promotion", "promotion_refused", "expand_promotion"] as const satisfies readonly FeatureRecordType[];
export type BlockRecordType = (typeof BLOCK_RECORD_TYPES)[number];

/** What a FeatureAgent asks of the ProjectAgent while it records a run and promotes, over RPC. */
export interface BlockProjectPort {
  /** Signs one record on the feature with the service key and keeps it; returns its id. */
  signBlockRecord(featureId: string, type: BlockRecordType, payload: Record<string, unknown>): Promise<string>;
  /** Takes the project's one promotion slot for `runId`; false while another promotion holds it. */
  acquirePromotion(featureId: string, runId: string): Promise<boolean>;
  releasePromotion(runId: string): Promise<void>;
  /** Main moved to the feature's checkpoint: the feature is `landed`. */
  featureLanded(featureId: string, promotion: Promotion): Promise<void>;
  /** A land run failed its checks or its push: the feature goes back to `building`. */
  landFailed(featureId: string, runId: string): Promise<void>;
  /** Checks the block again on main's new head after a refused push; see retryLand. */
  retryLand(featureId: string, runId: string, charter: CharterView): Promise<{ readonly status: string; readonly runId?: string; readonly reason?: string; readonly message?: string }>;
  /** Main moved to an expand checkpoint: the feature keeps building, and its person hears. */
  expandPromoted(featureId: string, promotion: Promotion): Promise<void>;
  /** Checks an expand again on main's new head after a refused push; see expand-promotion.ts retryExpand. */
  retryExpand(featureId: string, runId: string, charter: CharterView): Promise<{ readonly status: string; readonly runId?: string; readonly reason?: string; readonly message?: string }>;
  /**
   * A run's checks were recorded: the decisions the ladder gave an agent become edit tasks, and a
   * passing run does the feature's open ones (edit-work.ts). Absent, no task opens.
   */
  blockReported?(featureId: string, run: { readonly runId: string; readonly checkpoint: string; readonly passed: boolean }, decisions: readonly LadderDecision[]): Promise<void>;
  /**
   * The fixes written into any of `targets`' forks at or after `since`, each as `<part> into <feature>`
   * (fix-write.ts). A run that named those heads checked the block without them. Absent, none.
   */
  fixesWrittenSince?(targets: readonly string[], since: string): Promise<readonly string[]>;
  /**
   * The run's caller replay reached Penguin: the feature's caller items follow it (caller-items.ts
   * `replayReported`). Absent, a block run moves no item.
   */
  callerReplayReported?(featureId: string, run: { readonly runId: string; readonly checkpoint: string }, section: CallerReplaySection): Promise<void>;
  /** The feature's caller items not yet settled, as lines; a passing land run waits on them. Absent, none. */
  callersPending?(featureId: string): Promise<readonly string[]>;
}

export interface BlockReportDeps {
  readonly store: BlockStore;
  /** The feature's fix writes, to name in the promotion. */
  readonly fixWrites: (featureId: string) => FixWrite[];
  readonly port: BlockProjectPort;
  /** Mints Penguin's tokens, moves main and revokes them (main-push.ts). */
  readonly push: (run: BlockRun) => Promise<FastForwardOutcome>;
  /** Revokes every write token on the originating fork; returns how many. */
  readonly seal: (run: BlockRun) => Promise<number>;
  /**
   * Whether every part of the feature's plan still stands approved: plan `planId` for a land run, or
   * the feature's newest plan, when it has one, for an expand run, which names none. An author may
   * reverse Penguin's approval until the block reaches main, so a passing run whose plan lost an
   * approval is not promoted. Absent, the approvals the request checked stand.
   */
  readonly planApproved?: (featureId: string, planId: string | null) => boolean;
  readonly now?: () => number;
}

export type BlockReportResult =
  | {
      readonly status: "recorded";
      readonly runId: string;
      readonly state: BlockRunState;
      readonly passed: boolean;
      readonly recordId: string;
      readonly promotion: Promotion | null;
      /** After a refused push: the run that checks the block again, or why the land went back. */
      readonly retried: { readonly status: string; readonly runId?: string; readonly reason?: string } | null;
    }
  | { readonly status: "rejected"; readonly reason: "forbidden" | "not_found" | "invalid" | "superseded" | "conflict"; readonly message: string };

/**
 * Records the runner's report of run `runId` with its signed `block_checked` record. A land or expand
 * run that passed is promoted at once; a land run that failed returns the feature to `building`, where
 * an expand run's feature already is.
 */
export async function reportBlockRun(deps: BlockReportDeps, caller: BridgeCaller, runId: string, body: unknown): Promise<BlockReportResult> {
  if (caller.role !== "runner") return { status: "rejected", reason: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
  const run = deps.store.get(runId);
  if (run === undefined) return { status: "rejected", reason: "not_found", message: `no block run ${runId}` };
  const parsed = parseBlockRunReport(body, run.request);
  if (!parsed.ok) return { status: "rejected", reason: "invalid", message: parsed.problems.join("; ") };
  const verdict = blockVerdict(run.request, parsed.report.checks);
  const recorded = deps.store.report(runId, caller.bridgeId, parsed.report, verdict.passed);
  if (recorded.status === "rejected") return recorded;
  const reported = recorded.run;
  const checkMs = Date.parse(reported.reportedAt as string) - Date.parse(reported.requestedAt);
  const recordId = await deps.port.signBlockRecord(run.featureId, "block_checked", {
    run_id: runId,
    purpose: run.purpose,
    plan_id: run.planId,
    checkpoint: run.checkpoint,
    main_before: run.mainBefore,
    branch: run.request.branch,
    targets: targetFields(run.request.targets),
    passed: verdict.passed,
    unmerged: [...verdict.unmerged],
    main_tested: verdict.mainTested,
    checks: parsed.report.checks.map((check) => ({
      target: check.target,
      check: check.check,
      result: check.result,
      fingerprint: check.fingerprint?.id ?? null,
      log_ref: check.logRef,
    })),
    decisions: parsed.report.decisions.map((decision) => ({ target: decision.target, check: decision.check, step: decision.step, actor: decision.actor })),
    ...callerReplayFields(parsed.report.callerReplay),
    runner_ms: parsed.report.durationMs,
    check_ms: checkMs,
  });
  deps.store.setRecord(runId, recordId);
  if (parsed.report.callerReplay !== undefined) {
    try {
      await deps.port.callerReplayReported?.(run.featureId, { runId, checkpoint: run.checkpoint }, parsed.report.callerReplay);
    } catch (error) {
      // The report stands; the next replay moves the items again.
      console.error(JSON.stringify({ event: "caller_items_failed", run: runId, error: String(error).slice(0, 200) }));
    }
  }
  try {
    await deps.port.blockReported?.(run.featureId, { runId, checkpoint: run.checkpoint, passed: verdict.passed }, parsed.report.decisions);
  } catch (error) {
    // The report stands; the next run's report opens the tasks again.
    console.error(JSON.stringify({ event: "edit_tasks_failed", run: runId, error: String(error).slice(0, 200) }));
  }
  const result = { status: "recorded" as const, runId, passed: verdict.passed, recordId, promotion: null, retried: null };
  if (run.purpose === "plan_check") return { ...result, state: reported.state };
  if (!verdict.passed) {
    await deps.port.landFailed(run.featureId, runId);
    return { ...result, state: reported.state };
  }
  return { ...result, ...(await promote(deps, { ...reported, recordId }, checkMs)) };
}

/**
 * Whether `plan`, the feature's newest, still has every part approved for a run naming `planId`. A
 * land run names its plan, which must still be the newest. An expand run names none: a feature with no
 * plan passes, and one with a plan needs every part approved.
 */
export function planStillApproved(plan: Plan | undefined, planId: string | null): boolean {
  if (planId === null) return plan === undefined || plan.parts.every((part) => part.approvalState === "approved");
  return plan?.planId === planId && plan.parts.every((part) => part.approvalState === "approved");
}

/** Moves main to a passing land or expand run's checkpoint, or says why not. */
async function promote(
  deps: BlockReportDeps,
  run: BlockRun,
  checkMs: number,
): Promise<{ readonly state: BlockRunState; readonly promotion: Promotion | null; readonly retried: { readonly status: string; readonly runId?: string; readonly reason?: string } | null }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const expand = run.purpose === "expand";
  const retry = () =>
    expand ? deps.port.retryExpand(run.featureId, run.runId, run.request.charter) : deps.port.retryLand(run.featureId, run.runId, run.request.charter);
  const refuse = async (state: "raced" | "refused", reason: string, head: string | null) => {
    deps.store.transition(run.runId, ["passed", "promoting"], state, reason);
    await deps.port.signBlockRecord(run.featureId, "promotion_refused", {
      run_id: run.runId,
      main_before: run.mainBefore,
      checkpoint: run.checkpoint,
      main_head: head,
      reason,
      retried: state === "raced",
    });
  };
  if (deps.planApproved !== undefined && !deps.planApproved(run.featureId, run.planId)) {
    await refuse("refused", `a part of ${run.planId === null ? "the feature's plan" : `plan ${run.planId}`} is no longer approved`, null);
    await deps.port.landFailed(run.featureId, run.runId);
    return { state: "refused", promotion: null, retried: null };
  }
  // The run's own replay may have reset a caller item: main waits until the receiving side answers it.
  const callers = expand ? [] : ((await deps.port.callersPending?.(run.featureId)) ?? []);
  if (callers.length > 0) {
    await refuse("refused", callersPendingMessage(callers), null);
    await deps.port.landFailed(run.featureId, run.runId);
    return { state: "refused", promotion: null, retried: null };
  }
  // Each plan's block is checked on fork heads holding every fix written so far: a fix written into a
  // target after the run named its head means the block is checked again on the new heads.
  const later = (await deps.port.fixesWrittenSince?.(run.request.targets.map((target) => target.feature), run.requestedAt)) ?? [];
  if (later.length > 0) {
    await refuse("raced", `fixes were written into the targets' forks after the block was checked: ${later.slice(0, 10).join(", ")}`, null);
    return { state: "raced", promotion: null, retried: await retry() };
  }
  if (!(await deps.port.acquirePromotion(run.featureId, run.runId))) {
    await refuse("raced", "another promotion was moving main", null);
    return { state: "raced", promotion: null, retried: await retry() };
  }
  try {
    if (!deps.store.transition(run.runId, ["passed"], "promoting")) return { state: deps.store.get(run.runId)?.state ?? "passed", promotion: null, retried: null };
    const pushed = await deps.push(run);
    if (pushed.status === "moved") {
      await refuse("raced", `main moved to ${pushed.head ?? "nothing"} after the block was checked`, pushed.head);
      return { state: "raced", promotion: null, retried: await retry() };
    }
    if (pushed.status === "failed") {
      await refuse("refused", pushed.reason, pushed.head);
      await deps.port.landFailed(run.featureId, run.runId);
      return { state: "refused", promotion: null, retried: null };
    }
    const fixes = run.planId === null ? [] : deps.fixWrites(run.featureId).filter((write) => write.partId.startsWith(`${run.planId}#`));
    const promotedAt = now();
    const fields = {
      planId: run.planId,
      featureId: run.featureId,
      runId: run.runId,
      branch: run.request.branch,
      mainBefore: run.mainBefore,
      mainAfter: run.checkpoint,
      targets: targetFields(run.request.targets) as { feature: string; sha: string }[],
      fixes: fixes.map(({ partId, revision, targetRepo, commitSha }) => ({ partId, revision, targetRepo, commitSha })),
      checkRecordId: run.recordId as string,
      requestedAt: run.requestedAt,
      promotedAt: new Date(promotedAt).toISOString(),
      checkMs,
      promoteMs: promotedAt - started,
    };
    // An expand promotion is a record of its own: main moved, and the feature has not landed.
    const recordId = await deps.port.signBlockRecord(run.featureId, expand ? "expand_promotion" : "promotion", {
      run_id: run.runId,
      plan_id: run.planId,
      branch: fields.branch,
      main_before: fields.mainBefore,
      main_after: fields.mainAfter,
      targets: fields.targets,
      fixes: fields.fixes.map(({ partId, revision, targetRepo, commitSha }) => ({ part_id: partId, revision, target_repo: targetRepo, commit_sha: commitSha })),
      check_record: fields.checkRecordId,
      pack_bytes: pushed.packBytes,
      check_ms: checkMs,
      promote_ms: fields.promoteMs,
    });
    const promotion: Promotion = { schemaVersion: 1, ...(expand ? { purpose: "expand" as const } : {}), ...fields, recordId };
    deps.store.keepPromotion(promotion);
    if (expand) {
      // The fork keeps its write tokens: the feature builds on top of what reached main.
      await deps.port.expandPromoted(run.featureId, promotion);
      return { state: "promoted", promotion, retried: null };
    }
    try {
      await deps.seal(run);
    } catch (error) {
      // Main moved; the fork is still refused every new write token. The next land attempt reports it.
      console.error(JSON.stringify({ event: "fork_seal_failed", feature: run.featureId, error: String(error).slice(0, 200) }));
    }
    await deps.port.featureLanded(run.featureId, promotion);
    return { state: "promoted", promotion, retried: null };
  } finally {
    await deps.port.releasePromotion(run.runId);
  }
}

export interface LandedDeps {
  readonly features: FeatureStore;
  readonly queue: BlockQueueStore;
  /** Retires the feature's announced plan (plan-coverage.ts). */
  readonly retirePlan: (featureId: string) => void;
  /** Checks again each start an open lock of the feature held; a landed feature covers nothing, so each lock is withdrawn. */
  readonly recheckLocks: (featureId: string) => Promise<void>;
  readonly notify: (personId: string) => void;
}

/**
 * Main moved to the feature's checkpoint: the feature is `landed`. Its plan is retired, the starts it
 * held are checked again, and its person and every person whose fork carries one of its fixes hear.
 */
export async function featureLanded(deps: LandedDeps, featureId: string, promotion: Promotion): Promise<void> {
  const feature = deps.features.get(featureId);
  if (feature === undefined) return;
  deps.features.setState(featureId, ["landing", "building"], "landed");
  deps.queue.remove(featureId);
  deps.retirePlan(featureId);
  await deps.recheckLocks(featureId);
  const people = new Set([feature.personId]);
  for (const fix of promotion.fixes) {
    const target = deps.features.get(fix.targetRepo.replace(/^feature-/u, ""));
    if (target !== undefined) people.add(target.personId);
  }
  for (const person of people) deps.notify(person);
}

/** A land run failed its checks or main refused its push: the feature goes back to `building`. */
export function landFailed(deps: Pick<LandedDeps, "features" | "notify">, featureId: string): void {
  const feature = deps.features.get(featureId);
  if (feature === undefined) return;
  deps.features.setState(featureId, ["landing"], "building");
  deps.notify(feature.personId);
}

/** The signed record a FeatureAgent asks for, drafted and signed on the ProjectAgent. */
export async function signBlockRecord(
  features: FeatureStore,
  sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>,
  featureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!(BLOCK_RECORD_TYPES as readonly string[]).includes(type)) throw new Error(`a FeatureAgent does not sign ${type} records`);
  if (features.get(featureId) === undefined) throw new Error(`no feature ${featureId}`);
  const record = await sign(features.draftRecord(featureId, type as BlockRecordType, { penguin: true }, payload));
  features.addRecord(record);
  return record.record_id;
}
