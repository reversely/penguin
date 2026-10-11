// The agent tools of PRD section 5.2 as the ProjectAgent serves them: `whats_near`, `impact`, `check`
// and `apply_fix`. `whats_near` is answered here from the running features' areas, the scope map and
// the sessions. `impact`, `check` and `apply_fix` need the check runner's tools (Python, ruff,
// pyright, uv, libcst), so the ProjectAgent checks the request, records it and answers that it waits
// for the runner, as `submit_review` does for the side-by-side run. `apply_fix` accepts only the fixed
// fix kinds, files inside the caller's charter and codemod edits that are dotted Python names.
//
// Every call is recorded with its tool, caller, input and answer, so a feature page or a demo shows
// each tool's use and how many calls an agent made per resolution (PRD section 11).

import { withinCharter, type CharterIdentity } from "@penguin/policies";
import { codemodEditProblem, FIX_COMMAND_IDS, FIX_KINDS, type AgentToolName, type FixKind } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { parseAreaPath, parseFeatureId, type Feature, type FeatureStore } from "./feature-store.ts";
import type { FeatureRejection } from "./feature-open.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { findOverlaps, RUNNING_STATES, type Overlap } from "./overlap-lock.ts";
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

/** One recorded call of an agent tool. */
export interface AgentToolRun {
  readonly id: number;
  readonly featureId: string | null;
  readonly sessionId: string;
  /** The handle of the calling session's identity. */
  readonly caller: string;
  readonly tool: AgentToolName;
  readonly input: Readonly<Record<string, unknown>>;
  /** `found` for an answer, `waiting` for a request the check runner takes. */
  readonly result: "found" | "waiting";
  readonly summary: string;
  readonly checkpointSha: string | null;
  readonly durationMs: number;
  readonly createdAt: string;
}

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
    checkpointSha: row["checkpoint_sha"] === null ? null : String(row["checkpoint_sha"]),
    durationMs: Number(row["duration_ms"]),
    createdAt: new Date(Number(row["created_at"])).toISOString(),
  };
}

export class AgentToolStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of AGENT_TOOL_SCHEMA) db.exec(statement);
  }

  insert(run: Omit<AgentToolRun, "id" | "createdAt">): AgentToolRun {
    const [row] = this.#db.exec(
      `INSERT INTO AgentToolRun (feature_id, session_id, caller, tool, input, result, summary, checkpoint_sha, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
    );
    return toolRun(row as Row);
  }

  /** The recorded calls on one feature, oldest first. */
  list(featureId: string): AgentToolRun[] {
    return this.#db.exec(`SELECT * FROM AgentToolRun WHERE feature_id = ? ORDER BY id`, featureId).map(toolRun);
  }
}

export interface AgentToolDeps {
  readonly features: FeatureStore;
  readonly runs: AgentToolStore;
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  readonly session: (sessionId: string) => Session | undefined;
  /** The charter of an identity, by its id. */
  readonly identity: (identityId: string) => CharterIdentity | undefined;
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
  input: { readonly feature?: unknown; readonly kind?: unknown; readonly paths?: unknown; readonly edits?: unknown },
): Promise<ToolRequestOutcome> {
  const started = performance.now();
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature ${featureId}`);
  if (deps.features.featureOfSession(sessionId) !== featureId) {
    return rejected("forbidden", `this session is not an agent of feature ${featureId}`);
  }
  if (feature.latestCheckpointSha === null) return rejected("not_found", `feature ${featureId} has no checkpoint on its fork yet`);

  let recorded: Record<string, unknown> = { feature: featureId };
  let commandId: string | null = null;
  if (tool === "apply_fix") {
    const fix = await checkFix(deps, live.session, input);
    if (fix.status === "rejected") return fix;
    recorded = { feature: featureId, ...fix.input };
    commandId = FIX_COMMAND_IDS[fix.input.kind];
  }
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
  });
  return { status: "ok", runId: run.id, tool, featureId, checkpointSha: feature.latestCheckpointSha, input: recorded, commandId };
}

async function checkFix(
  deps: AgentToolDeps,
  session: Session,
  input: { readonly kind?: unknown; readonly paths?: unknown; readonly edits?: unknown },
): Promise<{ readonly status: "ok"; readonly input: { kind: FixKind; paths: string[]; edits?: unknown[] } } | FeatureRejection> {
  if (typeof input.kind !== "string" || !(FIX_KINDS as readonly string[]).includes(input.kind)) {
    return rejected("invalid", `kind must be one of ${FIX_KINDS.join(", ")}`);
  }
  const kind = input.kind as FixKind;
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
    if (input.edits !== undefined) return rejected("invalid", "only a codemod takes edits");
    return { status: "ok", input: { kind, paths: clean } };
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
