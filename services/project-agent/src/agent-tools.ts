// The agent tools of PRD section 5.2 as the ProjectAgent serves them: `whats_near`, `impact`, `check`
// and `apply_fix`. `whats_near` is answered here from the running features' areas, the scope map and
// the sessions. `impact`, `check` and `apply_fix` need the check runner's tools (Python, ruff,
// pyright, uv, libcst), so the ProjectAgent checks the request, records it with the checkpoint's
// baseline on main and answers that it waits for the runner, as `submit_review` does for the
// side-by-side run. The runner claims it under a lease and reports the result (agent-tool-runner.ts),
// which reaches the requesting session at its next safe checkpoint. `apply_fix` accepts only the
// fixed fix kinds, files inside the caller's charter and codemod edits that are dotted Python names.
//
// Retiring symbols (retiring-store.ts) reach the runner through these requests. An `impact` request
// carries them, so its result also lists the remaining callers grouped by owner. Each checkpoint of a
// feature with an agent session gets one `impact` request of Penguin's own, the retiring-calls check
// (`requestRetiringCheck`): the runner searches the checkpoint's own changes and returns one ladder
// step per file and retiring symbol they use. A step 3 names the declaring plan's rewrite rule, which
// `apply_fix` applies as a codemod by `rules`.
//
// The expand step of a split (contract-split.ts) reaches the runner through `apply_fix` too: with
// `kind: codemod` and `expand: true`, Penguin derives the codemod's edits and files from the feature's
// split itself, so the agent names neither, and the files must lie inside the caller's charter.
//
// Every call is recorded with its tool, caller, input and answer, so a feature page or a demo shows
// each tool's use and how many calls an agent made per resolution (PRD section 11).

import { withinCharter, type CharterIdentity } from "@penguin/policies";
import {
  codemodEditProblem,
  expandPlan,
  FIX_COMMAND_IDS,
  FIX_KINDS,
  type AgentToolName,
  type AgentToolResult,
  type CodemodEdit,
  type ContractSplitView,
  type FixKind,
  type RetiringDeclaration,
  type RewriteRule,
  type ToolRunResult,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { parseAreaPath, parseFeatureId, type Feature, type FeatureStore } from "./feature-store.ts";
import type { FeatureRejection } from "./feature-open.ts";
import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
import { findOverlaps, RUNNING_STATES, type Overlap } from "./overlap-lock.ts";
import { notStopped, RUN_FAILURE_SCHEMA, type StoreRelease } from "./run-failures.ts";
import type { Session, SessionOutcome } from "./session-store.ts";

type Row = Record<string, SqlValue>;

export const AGENT_TOOL_LIMITS = { paths: 256, scopes: 64, fixPaths: 2_000, edits: 50, listed: 100 } as const;

export const AGENT_TOOL_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS AgentToolRun (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT, session_id TEXT NOT NULL, caller TEXT NOT NULL,
    tool TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, summary TEXT NOT NULL,
    checkpoint_sha TEXT, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS AgentToolRun_feature ON AgentToolRun (feature_id, id)`,
];

/**
 * Columns added for the check runner's claim and result (#102). A table an earlier deploy created
 * lacks them, so the store adds each one that is missing.
 */
const RUNNER_COLUMNS: readonly (readonly [string, string])[] = [
  ["identity_id", "identity_id TEXT"],
  ["base_sha", "base_sha TEXT"],
  ["claimed_by", "claimed_by TEXT"],
  ["claimed_at", "claimed_at INTEGER"],
  ["completed_at", "completed_at INTEGER"],
  ["outcome", "outcome TEXT"],
  ["delivered_at", "delivered_at INTEGER"],
];

/** How long a claimed request stays with its runner before another claim may take it again. */
export const TOOL_RUN_LEASE_MS = 30 * 60_000;

/** The most requests one claim hands out. */
export const TOOL_RUN_CLAIM_LIMIT = 8;

/** The most delivered results `get_work` lists for a session, newest first. */
export const TOOL_RESULTS_LISTED = 10;

/** One recorded call of an agent tool. */
export interface AgentToolRun {
  readonly id: number;
  readonly featureId: string | null;
  readonly sessionId: string;
  /** The handle of the calling session's identity. */
  readonly caller: string;
  readonly tool: AgentToolName;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * `found` for an answer, `waiting` for a request the check runner has not reported yet, then the
   * runner's result: `found`, or for a fix `changed`, `unchanged` or `refused`, or `error`.
   */
  readonly result: ToolRunResult;
  readonly summary: string;
  readonly checkpointSha: string | null;
  readonly durationMs: number;
  readonly createdAt: string;
  /** The calling session's identity; null for `whats_near` and rows from before #102. */
  readonly identityId: string | null;
  /** The checkpoint's baseline on main, the runner's base; null for `whats_near`. */
  readonly baseSha: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
  /** The runner's result, once reported. */
  readonly outcome: AgentToolResult | null;
  /** When the requesting session's safe checkpoint delivered the result. */
  readonly deliveredAt: string | null;
}

/** A reported result as a session's safe checkpoint names it. */
export interface ToolResultRef {
  readonly runId: number;
  readonly tool: AgentToolName;
  readonly featureId: string;
  readonly result: ToolRunResult;
  readonly summary: string;
}

const text = (value: SqlValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
const time = (value: SqlValue | undefined): string | null =>
  value === null || value === undefined ? null : new Date(Number(value)).toISOString();

function toolRun(row: Row): AgentToolRun {
  return {
    id: Number(row["id"]),
    featureId: row["feature_id"] === null ? null : String(row["feature_id"]),
    sessionId: String(row["session_id"]),
    caller: String(row["caller"]),
    tool: String(row["tool"]) as AgentToolName,
    input: JSON.parse(String(row["input"])) as Record<string, unknown>,
    result: String(row["result"]) as AgentToolRun["result"],
    summary: String(row["summary"]),
    checkpointSha: text(row["checkpoint_sha"]),
    durationMs: Number(row["duration_ms"]),
    createdAt: time(row["created_at"]) as string,
    identityId: text(row["identity_id"]),
    baseSha: text(row["base_sha"]),
    claimedBy: text(row["claimed_by"]),
    claimedAt: time(row["claimed_at"]),
    completedAt: time(row["completed_at"]),
    outcome: typeof row["outcome"] === "string" ? (JSON.parse(row["outcome"]) as AgentToolResult) : null,
    deliveredAt: time(row["delivered_at"]),
  };
}

export type ToolRunClaimListing =
  | { readonly status: "ok"; readonly runs: readonly AgentToolRun[] }
  | { readonly status: "forbidden"; readonly message: string };

export class AgentToolStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #leaseMs: number;

  constructor(db: SqlDatabase, now: () => number = Date.now, leaseMs: number = TOOL_RUN_LEASE_MS) {
    this.#db = db;
    this.#now = now;
    this.#leaseMs = leaseMs;
    for (const statement of [...AGENT_TOOL_SCHEMA, ...RUN_FAILURE_SCHEMA]) db.exec(statement);
    // Column names and definitions come from the constant above, never from input.
    const present = new Set(db.exec(`PRAGMA table_info(AgentToolRun)`).map((row) => row["name"]));
    for (const [name, definition] of RUNNER_COLUMNS) {
      if (!present.has(name)) db.exec(`ALTER TABLE AgentToolRun ADD COLUMN ${definition}`);
    }
  }

  insert(
    run: Pick<AgentToolRun, "featureId" | "sessionId" | "caller" | "tool" | "input" | "result" | "summary" | "checkpointSha" | "durationMs"> &
      Partial<Pick<AgentToolRun, "identityId" | "baseSha">>,
  ): AgentToolRun {
    const [row] = this.#db.exec(
      `INSERT INTO AgentToolRun (feature_id, session_id, caller, tool, input, result, summary, checkpoint_sha, duration_ms, created_at,
         identity_id, base_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      run.featureId,
      run.sessionId,
      run.caller,
      run.tool,
      JSON.stringify(run.input),
      run.result,
      run.summary,
      run.checkpointSha,
      Math.round(run.durationMs),
      this.#now(),
      run.identityId ?? null,
      run.baseSha ?? null,
    );
    return toolRun(row as Row);
  }

  get(id: number): AgentToolRun | undefined {
    const [row] = this.#db.exec(`SELECT * FROM AgentToolRun WHERE id = ?`, id);
    return row === undefined ? undefined : toolRun(row);
  }

  /** The recorded calls on one feature, oldest first. */
  list(featureId: string): AgentToolRun[] {
    return this.#db.exec(`SELECT * FROM AgentToolRun WHERE feature_id = ? ORDER BY id`, featureId).map(toolRun);
  }

  /**
   * Hands the runner up to TOOL_RUN_CLAIM_LIMIT waiting requests, oldest first, and marks them
   * claimed by `caller`. A request is claimable while waiting and unclaimed, or when its claim's lease
   * ran out without a report. Only a bridge with the runner role may claim.
   */
  claim(caller: BridgeCaller): ToolRunClaimListing {
    if (caller.role !== "runner") return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    const now = this.#now();
    return this.#db.transaction((): ToolRunClaimListing => {
      const rows = this.#db.exec(
        `SELECT id FROM AgentToolRun WHERE result = 'waiting' AND base_sha IS NOT NULL
           AND (claimed_at IS NULL OR claimed_at <= ?) AND ${notStopped("tool", "id")} ORDER BY id LIMIT ?`,
        now - this.#leaseMs,
        TOOL_RUN_CLAIM_LIMIT,
      );
      const runs: AgentToolRun[] = [];
      for (const row of rows) {
        const id = Number(row["id"]);
        this.#db.exec(`UPDATE AgentToolRun SET claimed_by = ?, claimed_at = ? WHERE id = ?`, caller.bridgeId, now, id);
        runs.push(this.get(id) as AgentToolRun);
      }
      return { status: "ok", runs };
    });
  }

  /** Frees waiting request `id` from the claim `runnerId` holds, for the next claim of any runner. */
  release(id: number, runnerId: string): StoreRelease {
    const found = this.get(id);
    if (found === undefined || found.featureId === null) return { status: "rejected", reason: "not_found", message: `no tool request ${id}` };
    if (found.result !== "waiting") return { status: "rejected", reason: "conflict", message: `tool request ${id} is already reported` };
    if (found.claimedBy !== runnerId) return { status: "rejected", reason: "forbidden", message: `tool request ${id} is not claimed by this runner` };
    this.#db.exec(`UPDATE AgentToolRun SET claimed_by = NULL, claimed_at = NULL WHERE id = ?`, id);
    return { status: "released", featureId: found.featureId };
  }

  /**
   * Attaches the runner's result to request `id` while it waits. Returns the completed request, or
   * undefined when it was not waiting: a second report of the same request changes nothing.
   */
  complete(id: number, outcome: AgentToolResult): AgentToolRun | undefined {
    const [row] = this.#db.exec(
      `UPDATE AgentToolRun SET result = ?, summary = ?, outcome = ?, completed_at = ?
       WHERE id = ? AND result = 'waiting' RETURNING *`,
      outcome.result,
      outcome.summary,
      JSON.stringify(outcome),
      this.#now(),
      id,
    );
    return row === undefined ? undefined : toolRun(row);
  }

  /**
   * The reported results of session `sessionId` that no safe checkpoint has delivered yet, oldest
   * first, each marked delivered now (SessionStoreOptions.toolResultsFor).
   */
  deliver(sessionId: string): ToolResultRef[] {
    return (
      this.#db
        .exec(
          `UPDATE AgentToolRun SET delivered_at = ? WHERE session_id = ? AND completed_at IS NOT NULL AND delivered_at IS NULL
           RETURNING id, tool, feature_id, result, summary`,
          this.#now(),
          sessionId,
        )
        // RETURNING follows no order; the requests' own order is the order the agent asked in.
        .sort((a, b) => Number(a["id"]) - Number(b["id"]))
        .map((row) => ({
          runId: Number(row["id"]),
          tool: String(row["tool"]) as AgentToolName,
          featureId: String(row["feature_id"]),
          result: String(row["result"]) as ToolRunResult,
          summary: String(row["summary"]),
        }))
    );
  }

  /** The results delivered to session `sessionId`, newest first, at most TOOL_RESULTS_LISTED. */
  delivered(sessionId: string): AgentToolRun[] {
    return this.#db
      .exec(`SELECT * FROM AgentToolRun WHERE session_id = ? AND delivered_at IS NOT NULL ORDER BY id DESC LIMIT ?`, sessionId, TOOL_RESULTS_LISTED)
      .map(toolRun);
  }

  /**
   * The same results as `delivered` without their input or the runner's outcome, which can hold an
   * impact graph or a caller replay's calls: get_work lists these (#206).
   */
  deliveredSummaries(sessionId: string): ToolResultSummary[] {
    return this.#db
      .exec(
        `SELECT id, feature_id, tool, result, summary, checkpoint_sha, completed_at FROM AgentToolRun
         WHERE session_id = ? AND delivered_at IS NOT NULL ORDER BY id DESC LIMIT ?`,
        sessionId,
        TOOL_RESULTS_LISTED,
      )
      .map((row) => ({
        id: Number(row["id"]),
        featureId: row["feature_id"] === null ? null : String(row["feature_id"]),
        tool: String(row["tool"]) as AgentToolName,
        result: String(row["result"]) as AgentToolRun["result"],
        summary: String(row["summary"]),
        checkpointSha: text(row["checkpoint_sha"]),
        completedAt: time(row["completed_at"]),
      }));
  }
}

/** A delivered result as get_work lists it: no input and no outcome. */
export type ToolResultSummary = Pick<AgentToolRun, "id" | "featureId" | "tool" | "result" | "summary" | "checkpointSha" | "completedAt">;

export interface AgentToolDeps {
  readonly features: FeatureStore;
  readonly runs: AgentToolStore;
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  readonly session: (sessionId: string) => Session | undefined;
  /** The charter of an identity, by its id. */
  readonly identity: (identityId: string) => CharterIdentity | undefined;
  /** The checkpoint `sha` of fork `repo`'s baseline on main (`checkpointBaseline`). */
  readonly baseline: (repo: string, sha: string) => Promise<string>;
  /** The project's retiring symbols (retiring-store.ts); absent is none. */
  readonly retiring?: () => readonly RetiringDeclaration[];
  /** A feature's split (contract-split.ts); absent, no feature has one. */
  readonly split?: (featureId: string) => ContractSplitView | undefined;
  /**
   * The feature a caller that is no feature agent may ask about, such as a review task's run on the
   * feature it reviews (review-task.ts); absent, only a feature's own sessions may.
   */
  readonly workingOn?: (sessionId: string) => string | undefined;
}

/** A running feature near the asked paths or scopes, with its person and agents. */
export interface NearFeature {
  readonly featureId: string;
  readonly personId: string;
  readonly state: Feature["state"];
  /** Where the feature's area meets the asked paths and scopes, or null when it only depends on them. */
  readonly touches: Overlap | null;
  /** The scopes it works in that depend on an asked scope. */
  readonly dependsOn: readonly { readonly consumerScopeId: string; readonly providerScopeId: string; readonly kind: string }[];
  readonly agents: readonly { readonly handle: string; readonly vendor: string; readonly status: Session["status"] }[];
}

export type WhatsNearOutcome = { readonly status: "ok"; readonly runId: number; readonly features: readonly NearFeature[] } | FeatureRejection;

/** A request the check runner takes, as recorded. */
export type ToolRequestOutcome =
  | {
      readonly status: "ok";
      readonly runId: number;
      readonly tool: Exclude<AgentToolName, "whats_near">;
      readonly featureId: string;
      readonly checkpointSha: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly commandId: string | null;
    }
  | FeatureRejection;

const rejected = (reason: FeatureRejection["reason"], message: string): FeatureRejection => ({ status: "rejected", reason, message });

/**
 * The running features, other than the caller's own, whose areas touch the given paths or scopes, or
 * that work in a scope depending on one of them, each with its person and agent sessions.
 */
export async function whatsNear(deps: AgentToolDeps, caller: string, sessionId: string, input: { readonly paths?: unknown; readonly scopes?: unknown }): Promise<WhatsNearOutcome> {
  const started = performance.now();
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const scopeMap = await deps.scopeMap();
  const paths = listOf(input.paths, AGENT_TOOL_LIMITS.paths);
  const scopes = listOf(input.scopes, AGENT_TOOL_LIMITS.scopes);
  if (paths === undefined || scopes === undefined || paths.length + scopes.length === 0) {
    return rejected("invalid", `name 1 to ${AGENT_TOOL_LIMITS.paths} paths or 1 to ${AGENT_TOOL_LIMITS.scopes} scopes`);
  }
  const cleanPaths: string[] = [];
  for (const path of paths) {
    const clean = parseAreaPath(path);
    if (clean === undefined) return rejected("invalid", `${JSON.stringify(String(path).slice(0, 80))} is not a repository path`);
    cleanPaths.push(clean);
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || !scopeMap.scopes.has(scope)) return rejected("invalid", "each scope must be a scope id from penguin/scopes.json");
  }
  const own = deps.features.featureOfSession(sessionId);
  const asked: Feature = {
    id: own ?? "",
    personId: caller,
    repo: null,
    area: { scopes: scopes as string[], paths: cleanPaths, contracts: [] },
    state: "building",
    openedAt: "",
    latestCheckpointSha: null,
    updatedAt: "",
  };
  const running = deps.features.list().filter((feature) => RUNNING_STATES.has(feature.state) && feature.id !== own);
  const { covering, dependents } = findOverlaps(asked, running, scopeMap);
  const near = new Map<string, NearFeature>();
  const entry = (feature: Feature): NearFeature => {
    const known = near.get(feature.id);
    if (known !== undefined) return known;
    const agents = deps.features.sessions(feature.id).flatMap((id) => {
      const session = deps.session(id);
      return session === undefined ? [] : [{ handle: session.handle, vendor: session.vendor, status: session.status }];
    });
    const fresh = { featureId: feature.id, personId: feature.personId, state: feature.state, touches: null, dependsOn: [], agents };
    near.set(feature.id, fresh);
    return fresh;
  };
  for (const { feature, overlap } of covering) near.set(feature.id, { ...entry(feature), touches: overlap });
  for (const dependent of dependents) {
    const feature = running.find((item) => item.id === dependent.dependentFeatureId) as Feature;
    const known = entry(feature);
    const { consumerScopeId, providerScopeId, kind } = dependent;
    near.set(feature.id, { ...known, dependsOn: [...known.dependsOn, { consumerScopeId, providerScopeId, kind }] });
  }
  const features = [...near.values()].slice(0, AGENT_TOOL_LIMITS.listed);
  const run = deps.runs.insert({
    featureId: own ?? null,
    sessionId,
    caller: live.session.handle,
    tool: "whats_near",
    input: { paths: cleanPaths, scopes },
    result: "found",
    summary: `${features.length} running feature${features.length === 1 ? "" : "s"} near ${[...cleanPaths, ...(scopes as string[])].join(", ")}`.slice(0, 300),
    checkpointSha: null,
    durationMs: performance.now() - started,
  });
  return { status: "ok", runId: run.id, features };
}

/**
 * Records a request for `impact`, `check` or `apply_fix` on the caller's own feature, at the feature's
 * latest checkpoint, for the check runner. Refused: a session that is not an agent of the feature, a
 * feature with no checkpoint, an unknown fix kind, a file outside the caller's charter, a malformed
 * codemod edit.
 */
export async function requestTool(
  deps: AgentToolDeps,
  caller: string,
  sessionId: string,
  tool: Exclude<AgentToolName, "whats_near">,
  input: { readonly feature?: unknown; readonly kind?: unknown; readonly paths?: unknown; readonly edits?: unknown; readonly rules?: unknown; readonly expand?: unknown },
): Promise<ToolRequestOutcome> {
  const started = performance.now();
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature ${featureId}`);
  if ((deps.workingOn?.(sessionId) ?? deps.features.featureOfSession(sessionId)) !== featureId) {
    return rejected("forbidden", `this session is not an agent of feature ${featureId}`);
  }
  if (feature.latestCheckpointSha === null || feature.repo === null) {
    return rejected("not_found", `feature ${featureId} has no checkpoint on its fork yet`);
  }

  let recorded: Record<string, unknown> = { feature: featureId };
  let commandId: string | null = null;
  if (tool === "apply_fix") {
    const fix = await checkFix(deps, live.session, input, featureId);
    if (fix.status === "rejected") return fix;
    recorded = { feature: featureId, ...fix.input };
    commandId = FIX_COMMAND_IDS[fix.input.kind];
  }
  // With retiring symbols, the impact result also lists the remaining callers grouped by owner.
  const retiring = deps.retiring?.() ?? [];
  if (tool === "impact" && retiring.length > 0) recorded = { ...recorded, retiring: retiring.map(retiringInput) };
  // The runner compares the checkpoint with its baseline on main, as a review's side-by-side run does.
  const baseSha = await deps.baseline(feature.repo, feature.latestCheckpointSha);
  const run = deps.runs.insert({
    featureId,
    sessionId,
    caller: live.session.handle,
    tool,
    input: recorded,
    result: "waiting",
    summary: `${tool} on ${featureId}@${feature.latestCheckpointSha.slice(0, 12)} waits for the check runner`,
    checkpointSha: feature.latestCheckpointSha,
    durationMs: performance.now() - started,
    identityId: live.session.identityId,
    baseSha,
  });
  return { status: "ok", runId: run.id, tool, featureId, checkpointSha: feature.latestCheckpointSha, input: recorded, commandId };
}

/** A retiring symbol as a runner request carries it: what the analysis and the ladder need. */
export function retiringInput(each: RetiringDeclaration): RetiringDeclaration {
  const { contract, replacement, feature, planId, person, rules, recordId, declaredAt } = each;
  return { contract, replacement, feature, planId, person, rules, recordId, declaredAt };
}

/**
 * The retiring-calls check (PRD 0.5 section 5.1) on checkpoint `sha` of `feature`, reported by session
 * `sessionId`: one `impact` request of Penguin's own, searching the checkpoint's own changes for the
 * project's retiring symbols. Its result reaches the session at its next safe checkpoint with one next
 * step per file and symbol. Undefined when the project retires nothing, the session has no identity or
 * the checkpoint was already checked.
 */
export async function requestRetiringCheck(deps: AgentToolDeps, feature: Feature, sessionId: string, sha: string): Promise<number | undefined> {
  const retiring = deps.retiring?.() ?? [];
  const session = deps.session(sessionId);
  if (retiring.length === 0 || session === undefined || feature.repo === null) return undefined;
  const checked = deps.runs.list(feature.id).some((run) => run.checkpointSha === sha && run.input["search"] === "own");
  if (checked) return undefined;
  const started = performance.now();
  const baseSha = await deps.baseline(feature.repo, sha);
  const run = deps.runs.insert({
    featureId: feature.id,
    sessionId,
    caller: session.handle,
    tool: "impact",
    input: { feature: feature.id, search: "own", retiring: retiring.map(retiringInput) },
    result: "waiting",
    summary: `the retiring-calls check on ${feature.id}@${sha.slice(0, 12)} waits for the check runner`,
    checkpointSha: sha,
    durationMs: performance.now() - started,
    identityId: session.identityId,
    baseSha,
  });
  return run.id;
}

/** The rewrite rules of retiring symbols `ids` names, or a message naming the first unknown id. */
function retiringRules(deps: AgentToolDeps, ids: unknown): RewriteRule[] | string {
  const listed = listOf(ids, AGENT_TOOL_LIMITS.edits);
  if (listed === undefined || listed.length === 0) return `rules must name 1 to ${AGENT_TOOL_LIMITS.edits} rewrite rules of retiring symbols`;
  const known = new Map((deps.retiring?.() ?? []).flatMap((each) => each.rules.map((rule) => [rule.id, rule] as const)));
  const rules: RewriteRule[] = [];
  for (const id of new Set(listed)) {
    const rule = typeof id === "string" ? known.get(id) : undefined;
    if (rule === undefined) return `${JSON.stringify(String(id).slice(0, 80))} is not a rewrite rule of a retiring symbol`;
    rules.push(rule);
  }
  return rules;
}

type CheckedFix = { readonly status: "ok"; readonly input: { kind: FixKind; paths: string[]; edits?: unknown[]; rules?: RewriteRule[]; expand?: CodemodEdit[] } };

/**
 * The expand codemod of feature `featureId`'s split: the edits and files Penguin derives from the
 * split's incompatible entries, inside the caller's charter. Refused without a split waiting on its
 * expand, or when no entry is one the codemod expands.
 */
async function checkExpand(deps: AgentToolDeps, session: Session, input: { readonly paths?: unknown; readonly edits?: unknown; readonly rules?: unknown; readonly expand?: unknown }, featureId: string): Promise<CheckedFix | FeatureRejection> {
  if (input.expand !== true) return rejected("invalid", "expand is true or absent");
  if (input.paths !== undefined || input.edits !== undefined || input.rules !== undefined) {
    return rejected("invalid", "an expand codemod names no paths, edits or rules; Penguin derives them from the feature's split");
  }
  const split = deps.split?.(featureId);
  if (split === undefined || split.state !== "expand_first") return rejected("not_found", `feature ${featureId} has no split waiting on its expand`);
  const plan = expandPlan(split.entries);
  if (plan.edits.length === 0) {
    return rejected("invalid", `no incompatible entry of feature ${featureId} is a rename, move or keyword rename; write the parallel function for ${plan.manual.map((each) => each.symbol).join(", ")}`);
  }
  const identity = deps.identity(session.identityId);
  if (identity === undefined) return rejected("not_found", `no identity ${session.handle}`);
  const verdict = withinCharter(identity, undefined, [], [...plan.paths], await deps.scopeMap());
  if (!verdict.allowed) return rejected("forbidden", verdict.message);
  return { status: "ok", input: { kind: "codemod", paths: [...plan.paths], expand: [...plan.edits] } };
}

async function checkFix(
  deps: AgentToolDeps,
  session: Session,
  input: { readonly kind?: unknown; readonly paths?: unknown; readonly edits?: unknown; readonly rules?: unknown; readonly expand?: unknown },
  featureId: string,
): Promise<CheckedFix | FeatureRejection> {
  if (typeof input.kind !== "string" || !(FIX_KINDS as readonly string[]).includes(input.kind)) {
    return rejected("invalid", `kind must be one of ${FIX_KINDS.join(", ")}`);
  }
  const kind = input.kind as FixKind;
  if (input.expand !== undefined) {
    if (kind !== "codemod") return rejected("invalid", "only a codemod takes expand");
    return checkExpand(deps, session, input, featureId);
  }
  const paths = listOf(input.paths ?? [], AGENT_TOOL_LIMITS.fixPaths);
  if (paths === undefined) return rejected("invalid", `paths must list at most ${AGENT_TOOL_LIMITS.fixPaths} files`);
  if (kind === "lockfile" ? paths.length > 0 : paths.length === 0) {
    return rejected("invalid", kind === "lockfile" ? "a lockfile fix names no files" : `a ${kind} fix names the files it fixes`);
  }
  const clean: string[] = [];
  for (const path of paths) {
    const parsed = parseAreaPath(path);
    if (parsed === undefined || !parsed.endsWith(".py")) return rejected("invalid", `${JSON.stringify(String(path).slice(0, 80))} is not a Python file path`);
    clean.push(parsed);
  }
  const identity = deps.identity(session.identityId);
  if (identity === undefined) return rejected("not_found", `no identity ${session.handle}`);
  const verdict = withinCharter(identity, undefined, [], clean, await deps.scopeMap());
  if (!verdict.allowed) return rejected("forbidden", verdict.message);
  if (kind !== "codemod") {
    if (input.edits !== undefined || input.rules !== undefined) return rejected("invalid", "only a codemod takes edits or rules");
    return { status: "ok", input: { kind, paths: clean } };
  }
  // A codemod by the rewrite rules of retiring symbols: the ladder's step 3 for a new retiring call.
  if (input.rules !== undefined) {
    if (input.edits !== undefined) return rejected("invalid", "a codemod takes edits or rules, not both");
    const rules = retiringRules(deps, input.rules);
    if (typeof rules === "string") return rejected("invalid", rules);
    return { status: "ok", input: { kind, paths: clean, rules } };
  }
  const edits = listOf(input.edits, AGENT_TOOL_LIMITS.edits);
  if (edits === undefined || edits.length === 0) return rejected("invalid", `a codemod needs 1 to ${AGENT_TOOL_LIMITS.edits} edits`);
  for (const edit of edits) {
    const problem = codemodEditProblem(edit);
    if (problem !== null) return rejected("invalid", `a codemod edit is malformed: ${problem}`);
  }
  return { status: "ok", input: { kind, paths: clean, edits } };
}

function listOf(value: unknown, limit: number): unknown[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.length <= limit ? value : undefined;
}
