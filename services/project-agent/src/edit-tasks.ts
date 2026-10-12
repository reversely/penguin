// Edit tasks: their routing, delivery, queue and cap (PRD 0.5 section 4.4a).
//
// A source of work (a failed block check's next step, a plan part waiting for its review form, an
// approved fix to write, a migration part) opens one source here, under a key that names it. The
// store routes the source once, by charter (routeEdit in @penguin/protocol), and keeps one task per
// identity or person the places went to. Tasks of one source share its key: one block check covers
// them. A source that opens again while its tasks are open is not routed again.
//
// Delivery, in order:
// 1. A running session of the task's identity takes it at its next safe checkpoint (`deliver`). For a
//    builder, a running session of the same person working on the target feature counts too: a
//    builder's own sub-agents count as the builder.
// 2. With no such session, the person's bridge claims it (`claim`) and runs the identity headless.
//    A review form runs headless too, through Penguin's MCP server with a token for that task alone
//    (#138). A person holds at most `cap` running tasks; the rest wait, oldest first, behind the steward.
// 3. The person is asked, and the task waits as `asked`, only when their bridge has not polled within
//    the online window, when no identity's charter holds the place, or when a run failed, timed out
//    or stopped reporting. An `asked` task whose bridge was offline goes back to the queue when the
//    bridge polls again, as does a review asked before #138 (`needs_session`); a task whose run failed
//    stays with the person or a session.
//
// Every caller-supplied value reaches SQL as a bound parameter.

import {
  EDIT_TASK_LIMITS,
  OPEN_EDIT_TASK_STATES,
  routeEdit,
  type EditAskReason,
  type EditPlace,
  type EditQueue,
  type EditRoutingContext,
  type EditRouteVia,
  type EditTaskKind,
  type EditTaskReport,
  type EditTaskState,
} from "@penguin/protocol";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

/** A bridge that polled within this window is online. Bridges poll every few seconds while they run. */
export const BRIDGE_ONLINE_MS = 120_000;

export const EDIT_TASK_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS EditTask (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL UNIQUE, source_key TEXT NOT NULL, kind TEXT NOT NULL,
    feature_id TEXT NOT NULL, target_feature_id TEXT NOT NULL, files TEXT NOT NULL, scopes TEXT NOT NULL,
    instructions TEXT NOT NULL, verifier TEXT NOT NULL, evidence TEXT NOT NULL, ref TEXT NOT NULL,
    handle TEXT, person TEXT NOT NULL, via TEXT NOT NULL, state TEXT NOT NULL, ask_reason TEXT, session_id TEXT,
    claimed_by TEXT, lease_until INTEGER, attempts INTEGER NOT NULL, outcome TEXT, commit_sha TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS EditTask_source ON EditTask (source_key)`,
  `CREATE INDEX IF NOT EXISTS EditTask_person ON EditTask (person, state, id)`,
  `CREATE INDEX IF NOT EXISTS EditTask_feature ON EditTask (feature_id)`,
  `CREATE INDEX IF NOT EXISTS EditTask_target ON EditTask (target_feature_id)`,
  `CREATE TABLE IF NOT EXISTS BridgeSeen (person TEXT PRIMARY KEY, bridge_id TEXT NOT NULL, seen_at INTEGER NOT NULL)`,
];

/** One edit Penguin needs made, as a source opens it. */
export interface EditSource {
  /** Names the source; the tasks it opens share it. */
  readonly key: string;
  readonly kind: EditTaskKind;
  /** The feature whose work raised it. */
  readonly feature: string;
  /** The feature whose fork the edit goes into, or that a review form reviews. */
  readonly target: string;
  /** The target feature's person: a place no charter holds goes to them. */
  readonly targetPerson: string;
  /** The files or scopes the edit touches. A review names scopes only. */
  readonly places: readonly EditPlace[];
  readonly instructions: string;
  readonly verifier: string;
  readonly evidence?: readonly string[];
  /** What the source refers to, such as a part and revision or a block run, for the views and the claim. */
  readonly ref: Readonly<Record<string, string | number | null>>;
}

export interface EditTask {
  readonly id: number;
  readonly sourceKey: string;
  readonly kind: EditTaskKind;
  readonly feature: string;
  readonly target: string;
  readonly files: readonly string[];
  readonly scopes: readonly string[];
  readonly instructions: string;
  readonly verifier: string;
  readonly evidence: readonly string[];
  readonly ref: Readonly<Record<string, string | number | null>>;
  /** The identity that takes the task, or null when its person is asked. */
  readonly handle: string | null;
  readonly person: string;
  readonly via: EditRouteVia;
  readonly state: EditTaskState;
  readonly askReason: EditAskReason | null;
  readonly sessionId: string | null;
  readonly claimedBy: string | null;
  readonly leaseUntil: number | null;
  readonly attempts: number;
  readonly outcome: string | null;
  readonly commit: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Who may take a task now without the bridge: a running session that counts for the task's identity. */
export type SessionFor = (task: Pick<EditTask, "handle" | "person" | "via" | "target">) => boolean;

export type EditReportOutcome =
  | { readonly status: "ok"; readonly task: EditTask }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "not_found" | "conflict"; readonly message: string };

const parse = <T>(value: SqlValue): T => JSON.parse(value as string) as T;

function taskOf(row: Row): EditTask {
  const nullable = (key: string) => (row[key] === null ? null : (row[key] as string));
  return {
    id: Number(row["id"]),
    sourceKey: row["source_key"] as string,
    kind: row["kind"] as EditTaskKind,
    feature: row["feature_id"] as string,
    target: row["target_feature_id"] as string,
    files: parse<string[]>(row["files"]),
    scopes: parse<string[]>(row["scopes"]),
    instructions: row["instructions"] as string,
    verifier: row["verifier"] as string,
    evidence: parse<string[]>(row["evidence"]),
    ref: parse<Record<string, string | number | null>>(row["ref"]),
    handle: nullable("handle"),
    person: row["person"] as string,
    via: row["via"] as EditRouteVia,
    state: row["state"] as EditTaskState,
    askReason: nullable("ask_reason") as EditAskReason | null,
    sessionId: nullable("session_id"),
    claimedBy: nullable("claimed_by"),
    leaseUntil: row["lease_until"] === null ? null : Number(row["lease_until"]),
    attempts: Number(row["attempts"]),
    outcome: nullable("outcome"),
    commit: nullable("commit_sha"),
    createdAt: new Date(Number(row["created_at"])).toISOString(),
    updatedAt: new Date(Number(row["updated_at"])).toISOString(),
  };
}

const OPEN = `state IN (${OPEN_EDIT_TASK_STATES.map((state) => `'${state}'`).join(", ")})`;
const SHA = /^[0-9a-f]{40}$/u;

export interface EditTaskStoreOptions {
  readonly now?: () => number;
  readonly bridgeOnlineMs?: number;
}

export class EditTaskStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #onlineMs: number;

  constructor(db: SqlDatabase, options: EditTaskStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#onlineMs = options.bridgeOnlineMs ?? BRIDGE_ONLINE_MS;
    for (const statement of EDIT_TASK_SCHEMA) db.exec(statement);
  }

  /**
   * Opens a source's tasks: routes its places once and keeps one task per identity or person. A
   * source whose tasks are still open keeps them and is not routed again. Returns the source's open tasks.
   */
  open(source: EditSource, context: EditRoutingContext): EditTask[] {
    return this.#db.transaction(() => this.#open(source, context));
  }

  #open(source: EditSource, context: EditRoutingContext): EditTask[] {
    const existing = this.#openOf(source.key);
    if (existing.length > 0) return existing;
    const target = source.kind === "review" ? ({ kind: "main" } as const) : ({ kind: "feature", feature: source.target, person: source.targetPerson } as const);
    const routes = routeEdit(target, source.places, context, source.targetPerson);
    const now = this.#now();
    const evidence = (source.evidence ?? []).slice(0, EDIT_TASK_LIMITS.evidenceLines).map((line) => line.slice(0, EDIT_TASK_LIMITS.evidenceLineLength));
    for (const route of routes) {
      const state: EditTaskState = route.handle === null ? "asked" : "queued";
      this.#db.exec(
        `INSERT INTO EditTask (task_key, source_key, kind, feature_id, target_feature_id, files, scopes, instructions, verifier,
           evidence, ref, handle, person, via, state, ask_reason, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (task_key) DO UPDATE SET state = excluded.state, ask_reason = excluded.ask_reason, session_id = NULL,
           claimed_by = NULL, lease_until = NULL, outcome = NULL, commit_sha = NULL, files = excluded.files,
           scopes = excluded.scopes, instructions = excluded.instructions, verifier = excluded.verifier,
           evidence = excluded.evidence, ref = excluded.ref, updated_at = excluded.updated_at`,
        `${source.key}:${route.handle ?? `person:${route.person}`}`,
        source.key,
        source.kind,
        source.feature,
        source.target,
        JSON.stringify(route.paths.slice(0, EDIT_TASK_LIMITS.paths)),
        JSON.stringify(route.scopes.slice(0, EDIT_TASK_LIMITS.scopes)),
        source.instructions.slice(0, EDIT_TASK_LIMITS.instructionsLength),
        source.verifier.slice(0, EDIT_TASK_LIMITS.verifierLength),
        JSON.stringify(evidence),
        JSON.stringify(source.ref),
        route.handle,
        route.person,
        route.via,
        state,
        route.handle === null ? "no_identity" : null,
        now,
        now,
      );
    }
    return this.#openOf(source.key);
  }

  /**
   * Opens `sources` and closes every other open task whose source key starts with `prefix`, as `state`:
   * the work that raised them moved on (`dropped`) or was done (`done`).
   */
  replace(prefix: string, sources: readonly EditSource[], context: EditRoutingContext, state: "done" | "dropped", outcome: string): void {
    this.#db.transaction(() => {
      const keep = new Set(sources.map((source) => source.key));
      for (const source of sources) this.#open(source, context);
      const stale = this.#db
        .exec(`SELECT DISTINCT source_key FROM EditTask WHERE ${OPEN} AND substr(source_key, 1, ?) = ?`, prefix.length, prefix)
        .map((row) => row["source_key"] as string)
        .filter((key) => !keep.has(key));
      for (const key of stale) this.close(key, state, outcome);
    });
  }

  /** Closes a source's open tasks. */
  close(sourceKey: string, state: "done" | "dropped", outcome: string, commit: string | null = null): void {
    this.#db.exec(
      `UPDATE EditTask SET state = ?, outcome = COALESCE(outcome, ?), commit_sha = COALESCE(commit_sha, ?), claimed_by = NULL,
         lease_until = NULL, updated_at = ? WHERE source_key = ? AND ${OPEN}`,
      state,
      outcome.slice(0, EDIT_TASK_LIMITS.outcomeLength),
      commit,
      this.#now(),
      sourceKey,
    );
  }

  /** Every open source key that starts with `prefix`. */
  openSources(prefix: string): string[] {
    return this.#db
      .exec(`SELECT DISTINCT source_key FROM EditTask WHERE ${OPEN} AND substr(source_key, 1, ?) = ?`, prefix.length, prefix)
      .map((row) => row["source_key"] as string);
  }

  get(id: number): EditTask | undefined {
    const [row] = this.#db.exec(`SELECT * FROM EditTask WHERE id = ?`, id);
    return row === undefined ? undefined : taskOf(row);
  }

  /**
   * Moves each task to where it stands now: a run whose lease ran out, or a delivered task whose session
   * stopped, waits again; a queued task with no session and no bridge online asks its person; an
   * asked task whose bridge came back goes back to the queue.
   */
  settle(sessionFor: SessionFor, sessionRunning: (sessionId: string) => boolean): void {
    this.#db.transaction(() => {
      const now = this.#now();
      this.#db.exec(
        `UPDATE EditTask SET state = 'asked', ask_reason = 'lease_expired', claimed_by = NULL, lease_until = NULL, updated_at = ?
         WHERE state = 'running' AND lease_until < ?`,
        now,
        now,
      );
      for (const task of this.#tasksIn(["delivered", "queued", "asked"])) {
        if (task.state === "delivered") {
          if (task.sessionId !== null && sessionRunning(task.sessionId)) continue;
          this.#move(task.id, "queued", null, now);
          continue;
        }
        if (task.handle === null) continue;
        const waiting = this.#waitingState(task, sessionFor);
        if (task.state === "asked" && !["bridge_offline", "needs_session"].includes(task.askReason ?? "")) continue;
        if (waiting.state !== task.state || waiting.reason !== task.askReason) this.#move(task.id, waiting.state, waiting.reason, now);
      }
    });
  }

  /**
   * A safe checkpoint of a running session: each waiting task the session counts for is delivered to
   * it, so get_work lists it from now on. Returns the tasks delivered.
   */
  deliver(sessionId: string, counts: SessionFor): EditTask[] {
    return this.#db.transaction(() => {
      const now = this.#now();
      const delivered: EditTask[] = [];
      for (const task of this.#tasksIn(["queued", "asked"])) {
        if (task.handle === null || !counts(task)) continue;
        this.#db.exec(`UPDATE EditTask SET state = 'delivered', session_id = ?, ask_reason = NULL, updated_at = ? WHERE id = ?`, sessionId, now, task.id);
        delivered.push(this.get(task.id) as EditTask);
      }
      return delivered;
    });
  }

  /** The tasks delivered to a session and still open, oldest first. */
  forSession(sessionId: string): EditTask[] {
    return this.#db.exec(`SELECT * FROM EditTask WHERE session_id = ? AND state = 'delivered' ORDER BY id`, sessionId).map(taskOf);
  }

  /**
   * The bridge of `person` polls: it is online from now on, and it claims the person's oldest waiting
   * tasks that no session takes, up to `cap` running at once. Each claim holds until `leaseMs` from now.
   * `claimable` leaves out the tasks this bridge cannot run.
   */
  claim(person: string, bridgeId: string, cap: number, leaseMs: number, sessionFor: SessionFor, claimable: (task: EditTask) => boolean = () => true): EditTask[] {
    return this.#db.transaction(() => {
      const now = this.#now();
      this.#db.exec(
        `INSERT INTO BridgeSeen (person, bridge_id, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (person) DO UPDATE SET bridge_id = excluded.bridge_id, seen_at = excluded.seen_at`,
        person,
        bridgeId,
        now,
      );
      const running = Number(this.#db.exec(`SELECT COUNT(*) AS n FROM EditTask WHERE person = ? AND state = 'running'`, person)[0]?.["n"] ?? 0);
      const room = Math.max(0, cap - running);
      const claimed: EditTask[] = [];
      if (room === 0) return claimed;
      const waiting = this.#db
        .exec(
          `SELECT * FROM EditTask WHERE person = ? AND handle IS NOT NULL
             AND (state = 'queued' OR (state = 'asked' AND ask_reason IN ('bridge_offline', 'needs_session'))) ORDER BY id`,
          person,
        )
        .map(taskOf)
        .filter((task) => !sessionFor(task) && claimable(task));
      for (const task of waiting.slice(0, room)) {
        this.#db.exec(
          `UPDATE EditTask SET state = 'running', ask_reason = NULL, claimed_by = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
          bridgeId,
          now + leaseMs,
          now,
          task.id,
        );
        claimed.push(this.get(task.id) as EditTask);
      }
      return claimed;
    });
  }

  /** Returns running task `id` to the queue undone, as if it had not been claimed. */
  unclaim(id: number): void {
    this.#db.exec(
      `UPDATE EditTask SET state = 'queued', claimed_by = NULL, lease_until = NULL, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ? AND state = 'running'`,
      this.#now(),
      id,
    );
  }

  /**
   * The claiming bridge reports a run's end. `done` closes the task with its commit, or for a review
   * with no commit, which the caller checked first; `failed` and `timeout` release it to the person,
   * who is asked.
   */
  report(bridgeId: string, taskId: number, report: EditTaskReport): EditReportOutcome {
    return this.#db.transaction((): EditReportOutcome => {
      const task = this.get(taskId);
      const problem = reportProblem(report, task?.kind);
      if (problem !== null) return { status: "rejected", reason: "invalid", message: problem };
      if (task === undefined) return { status: "rejected", reason: "not_found", message: `no edit task ${taskId}` };
      if (task.claimedBy !== bridgeId) return { status: "rejected", reason: "forbidden", message: `edit task ${taskId} is not claimed by this bridge` };
      if (task.state !== "running") return { status: "rejected", reason: "conflict", message: `edit task ${taskId} is ${task.state}, not running` };
      const now = this.#now();
      const outcome = report.outcome.slice(0, EDIT_TASK_LIMITS.outcomeLength);
      if (report.status === "done") {
        this.#db.exec(
          `UPDATE EditTask SET state = 'done', outcome = ?, commit_sha = ?, claimed_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
          outcome,
          report.commit ?? null,
          now,
          taskId,
        );
      } else {
        this.#db.exec(
          `UPDATE EditTask SET state = 'asked', ask_reason = ?, outcome = ?, claimed_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
          report.status === "timeout" ? "run_timeout" : "run_failed",
          outcome,
          now,
          taskId,
        );
      }
      return { status: "ok", task: this.get(taskId) as EditTask };
    });
  }

  /**
   * The person's queue: running, waiting and asked tasks. With `via`, only the tasks routed that way,
   * such as the steward's own queue the team page shows (#136).
   */
  queue(person: string, cap: number, via?: EditRouteVia): EditQueue {
    const routed = via === undefined ? "" : " AND via = ?";
    const counts = new Map(
      this.#db
        .exec(`SELECT state, COUNT(*) AS n FROM EditTask WHERE person = ?${routed} AND state IN ('running', 'queued', 'asked') GROUP BY state`, ...(via === undefined ? [person] : [person, via]))
        .map((row) => [row["state"] as string, Number(row["n"])]),
    );
    return { running: counts.get("running") ?? 0, queued: counts.get("queued") ?? 0, asked: counts.get("asked") ?? 0, cap };
  }

  /** The tasks a feature raised or whose fork they edit, oldest first. */
  forFeature(featureId: string): EditTask[] {
    return this.#db.exec(`SELECT * FROM EditTask WHERE feature_id = ? OR target_feature_id = ? ORDER BY id`, featureId, featureId).map(taskOf);
  }

  /** Every task one source opened, open or closed. */
  forSource(sourceKey: string): EditTask[] {
    return this.#db.exec(`SELECT * FROM EditTask WHERE source_key = ? ORDER BY id`, sourceKey).map(taskOf);
  }

  /** Whether the person's bridge polled within the online window. */
  bridgeOnline(person: string): boolean {
    const [row] = this.#db.exec(`SELECT seen_at FROM BridgeSeen WHERE person = ?`, person);
    return row !== undefined && Number(row["seen_at"]) >= this.#now() - this.#onlineMs;
  }

  #openOf(sourceKey: string): EditTask[] {
    return this.#db.exec(`SELECT * FROM EditTask WHERE source_key = ? AND ${OPEN} ORDER BY id`, sourceKey).map(taskOf);
  }

  #tasksIn(states: readonly EditTaskState[]): EditTask[] {
    return this.#db.exec(`SELECT * FROM EditTask WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY id`, ...states).map(taskOf);
  }

  /** Where an undelivered task waits: queued for a session or the bridge, or asked with why. */
  #waitingState(task: EditTask, sessionFor: SessionFor): { readonly state: "queued" | "asked"; readonly reason: EditAskReason | null } {
    if (sessionFor(task)) return { state: "queued", reason: null };
    return this.bridgeOnline(task.person) ? { state: "queued", reason: null } : { state: "asked", reason: "bridge_offline" };
  }

  #move(id: number, state: EditTaskState, reason: EditAskReason | null, now: number): void {
    this.#db.exec(`UPDATE EditTask SET state = ?, ask_reason = ?, session_id = NULL, updated_at = ? WHERE id = ?`, state, reason, now, id);
  }
}

/** Why a bridge's report is malformed, or null. A review's done report names no commit. */
function reportProblem(report: EditTaskReport, kind: EditTaskKind | undefined): string | null {
  if (typeof report !== "object" || report === null) return "the report must be an object";
  if (!["done", "failed", "timeout"].includes(report.status as string)) return "status must be done, failed or timeout";
  if (typeof report.outcome !== "string" || report.outcome.trim() === "" || /[\u0000-\u001f\u007f]/u.test(report.outcome)) {
    return "outcome must be one line of text";
  }
  if (kind === "review") {
    if (report.commit !== undefined) return "a review's report names no commit: its result is the form it submitted";
  } else if (report.status === "done" && (typeof report.commit !== "string" || !SHA.test(report.commit))) {
    return "a done report names its commit as a full 40-character SHA";
  }
  return null;
}
