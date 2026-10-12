// Edit tasks and who runs them (PRD 0.5 core concepts and section 4.4a).
//
// An edit task is one edit Penguin needs made: a migration part, the removal of a split's retiring
// symbols in a feature Penguin opened for it (`contract`), an approved fix written into a fork, a next
// step after a failed check, or a review form. It names the fork it edits, the files or scopes,
// Penguin's instructions and the checks that verify it.
//
// Each person has one steward: an ordinary identity Penguin creates, `@<person>/steward`, whose
// charter lists every scope the person owns. Each feature gets one builder at open, an ordinary
// identity whose charter is the feature's declared area. Penguin routes each place of a task by
// charter: a place in a feature's fork goes to that feature's builder when the builder's charter holds
// it, then to the steward of the place's scope owner, then to a person. A task whose places fall under
// two charters becomes one task per charter; the tasks share one block, so one block check covers them.
//
// Routing is a pure function of the places and the charters, shared by the ProjectAgent, which routes
// each task once when it opens it, and the check runner's resolution ladder, which names the actor.

import { FIX_WRITE_SPEC_SCHEMA, type FixWriteSpec } from "./fix-write.ts";
import { IDENTITY_HANDLE_MAX_LENGTH, SEGMENT_PATTERN } from "./operation-schema.ts";
import type { PartTrialFix, PartTrialTarget } from "./part-trial.ts";
import { PATCH_LIMITS } from "./patch.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

export const EDIT_TASK_KINDS = ["migration", "contract", "fix", "next_step", "review"] as const;
export type EditTaskKind = (typeof EDIT_TASK_KINDS)[number];

/**
 * Where a task stands. `queued`: routed and waiting for a session's next safe checkpoint or the
 * person's bridge. `delivered`: a running session of the identity took it at a safe checkpoint.
 * `running`: the person's bridge claimed it and runs the identity headless. `asked`: the person is
 * asked to start a session (see `EditAskReason`). `done`: the edit was made. `dropped`: the work that
 * asked for it moved on.
 */
export const EDIT_TASK_STATES = ["queued", "delivered", "running", "asked", "done", "dropped"] as const;
export type EditTaskState = (typeof EDIT_TASK_STATES)[number];

/** States a task leaves only for `done` or `dropped`, or another of these. */
export const OPEN_EDIT_TASK_STATES: readonly EditTaskState[] = ["queued", "delivered", "running", "asked"];

/**
 * Why a task waits on its person. `bridge_offline`: no session runs and the person's bridge has not
 * polled lately. `needs_session`: a review form asked before headless runs could submit one (#138);
 * Penguin no longer asks for this reason and puts such a task back in the queue. `no_identity`: no
 * identity's charter holds the place. `run_failed`, `run_timeout`: the bridge's run failed or ran out
 * of time. `lease_expired`: the bridge stopped reporting during a run.
 */
export const EDIT_ASK_REASONS = ["bridge_offline", "needs_session", "no_identity", "run_failed", "run_timeout", "lease_expired"] as const;
export type EditAskReason = (typeof EDIT_ASK_REASONS)[number];

/** Background runs one person's bridge holds at once unless the project sets another number. */
export const BACKGROUND_RUN_CAP_DEFAULT = 2;
export const BACKGROUND_RUN_CAP_MAX = 8;

/**
 * Parses PENGUIN_BACKGROUND_RUN_CAP: unset is the default, a whole number from 1 to the maximum is
 * taken, anything else is undefined, which the caller treats as the default.
 */
export function parseBackgroundRunCap(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return BACKGROUND_RUN_CAP_DEFAULT;
  if (!/^[1-9][0-9]?$/u.test(value)) return undefined;
  const cap = Number(value);
  return cap <= BACKGROUND_RUN_CAP_MAX ? cap : undefined;
}

/** How long one background run may hold its task and its token unless the project sets another number. */
export const EDIT_RUN_MINUTES_DEFAULT = 20;
export const EDIT_RUN_MINUTES_MAX = 60;

/** Parses PENGUIN_EDIT_RUN_MINUTES into milliseconds, like parseBackgroundRunCap. */
export function parseEditRunMinutes(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return EDIT_RUN_MINUTES_DEFAULT * 60_000;
  if (!/^[1-9][0-9]?$/u.test(value)) return undefined;
  const minutes = Number(value);
  return minutes <= EDIT_RUN_MINUTES_MAX ? minutes * 60_000 : undefined;
}

// Stewards and builders.

export const STEWARD_NAME = "steward";

/** A person's steward: `@<person>/steward`. */
export function stewardHandle(person: string): string {
  return `@${person}/${STEWARD_NAME}`;
}

export const STEWARD_JOB = "Acts for its person on work that arrives from colleagues in the scopes they own: review forms, edits Penguin routes into those scopes and checks that fail there.";

export function builderJob(featureId: string): string {
  return `Builds feature ${featureId} inside its declared area.`;
}

/**
 * The handle a feature's builder takes: `@<person>/<feature>`, the feature id with dots turned into
 * hyphens and cut to fit the handle length. `attempt` above 1 appends `-<attempt>`, for a handle
 * another identity already holds. A feature named `steward` builds as `steward-feature`.
 */
export function builderHandle(person: string, featureId: string, attempt = 1): string {
  const suffix = attempt > 1 ? `-${attempt}` : "";
  let name = featureId.replaceAll(".", "-").replace(/-+/gu, "-");
  if (name === STEWARD_NAME) name = `${STEWARD_NAME}-feature`;
  const room = IDENTITY_HANDLE_MAX_LENGTH - person.length - 2 - suffix.length;
  name = name.slice(0, Math.max(room, 1)).replace(/-+$/u, "");
  return `@${person}/${name}${suffix}`;
}

// Routing.

/** An identity's charter as routing reads it. */
export interface EditCharter {
  readonly handle: string;
  readonly person: string;
  readonly scopes: readonly string[];
  /** Normalized path prefixes, without a trailing slash. */
  readonly paths: readonly string[];
}

/** One place a task edits or reviews: a file, a scope, or both. */
export interface EditPlace {
  readonly path?: string | null;
  readonly scope?: string | null;
}

/**
 * The fork a task edits: a feature's fork, or main for a review form or an edit to a scope on main,
 * which goes to the steward of the scope's DRI, or of the fallback standing in.
 */
export type EditTarget = { readonly kind: "feature"; readonly feature: string; readonly person: string } | { readonly kind: "main" };

export interface EditRoutingContext {
  /** The scope a repository path falls in. */
  readonly scopeOf: (path: string) => string | undefined;
  /**
   * The person who answers for a scope now: its DRI, or while the DRI is away the first available
   * member of its fallback order (#135).
   */
  readonly ownerOf: (scope: string) => string | undefined;
  /**
   * The scope's DRI. When `ownerOf` names someone else, that person stands in, and their steward takes
   * the scope's places though its charter holds only the scopes its person is DRI for. Absent, nobody
   * stands in.
   */
  readonly driOf?: (scope: string) => string | undefined;
  /** A feature's builder, or undefined when the feature has none. */
  readonly builderOf: (featureId: string) => EditCharter | undefined;
  /** A person's steward, or undefined when the person has none. */
  readonly stewardOf: (person: string) => EditCharter | undefined;
}

export type EditRouteVia = "builder" | "steward" | "person";

/** The places one identity takes, or one person is asked about when no identity's charter holds them. */
export interface EditRoute {
  readonly via: EditRouteVia;
  /** The identity, or null when the person is asked. */
  readonly handle: string | null;
  readonly person: string;
  readonly paths: readonly string[];
  readonly scopes: readonly string[];
}

/** Whether `charter` holds `path` in scope `scope`: a charter scope, or a path at or under a charter path. */
export function charterHolds(charter: Pick<EditCharter, "scopes" | "paths">, path: string | null, scope: string | undefined): boolean {
  if (scope !== undefined && charter.scopes.includes(scope)) return true;
  return path !== null && charter.paths.some((prefix) => {
    const trimmed = prefix.replace(/\/+$/u, "");
    return trimmed === "" || path === trimmed || path.startsWith(`${trimmed}/`);
  });
}

/**
 * Routes each place of a task by charter (PRD 4.4a step 1) and groups the places by who takes them.
 * A place in a feature's fork goes to that feature's builder when its charter holds the place; any
 * other place goes to the steward of the person who answers for its scope (`ownerOf`), when its
 * charter holds the place or that person stands in for the DRI; a place no charter holds goes to a
 * person: that person, else the target feature's person, else `fallbackPerson`. Groups keep the order
 * in which their first place appears, and each lists its paths and scopes sorted.
 */
export function routeEdit(target: EditTarget, places: readonly EditPlace[], context: EditRoutingContext, fallbackPerson: string): EditRoute[] {
  const groups = new Map<string, { via: EditRouteVia; handle: string | null; person: string; paths: Set<string>; scopes: Set<string> }>();
  const builder = target.kind === "feature" ? context.builderOf(target.feature) : undefined;
  for (const place of places) {
    const path = place.path ?? null;
    const scope = place.scope ?? (path === null ? undefined : context.scopeOf(path));
    let via: EditRouteVia;
    let handle: string | null;
    let person: string;
    const owner = scope === undefined ? undefined : context.ownerOf(scope);
    const steward = owner === undefined ? undefined : context.stewardOf(owner);
    const standsIn = scope !== undefined && context.driOf !== undefined && context.driOf(scope) !== owner;
    if (builder !== undefined && charterHolds(builder, path, scope)) {
      [via, handle, person] = ["builder", builder.handle, builder.person];
    } else if (steward !== undefined && (standsIn || charterHolds(steward, path, scope))) {
      [via, handle, person] = ["steward", steward.handle, steward.person];
    } else {
      [via, handle, person] = ["person", null, owner ?? (target.kind === "feature" ? target.person : fallbackPerson)];
    }
    const key = handle ?? `person:${person}`;
    const group = groups.get(key) ?? { via, handle, person, paths: new Set<string>(), scopes: new Set<string>() };
    groups.set(key, group);
    if (path !== null) group.paths.add(path);
    if (scope !== undefined) group.scopes.add(scope);
  }
  return [...groups.values()].map(({ via, handle, person, paths, scopes }) => ({ via, handle, person, paths: [...paths].sort(), scopes: [...scopes].sort() }));
}

// The task as the person's bridge claims it.

/**
 * The MCP tools a headless review run may call, with the task's own token: the form itself and the
 * two read tools a reviewer uses. The token refuses every other tool.
 */
export const REVIEW_TASK_TOOLS = ["submit_review", "whats_near", "impact"] as const;
export type ReviewTaskTool = (typeof REVIEW_TASK_TOOLS)[number];

/**
 * The trial tree of the part revision a review covers, as the part's trial builds it (part-trial.ts):
 * the target, with the originating checkpoint merged in and the part's fix applied. The review run
 * reads this tree, so the agent sees the fix it reviews (#140).
 */
export interface EditReviewTrial {
  readonly checkpoint: string;
  readonly target: PartTrialTarget;
  readonly fix: PartTrialFix;
}

/** The one part revision and scope a review task's form covers, on the feature that proposed the plan. */
export interface EditReviewTarget {
  readonly feature: string;
  readonly scope: string;
  readonly part: string;
  readonly revision: number;
  /** Null when the part's fix has no base to apply against; the run then reads the fork alone. */
  readonly trial: EditReviewTrial | null;
}

export const EDIT_TASK_LIMITS = {
  instructionsLength: 4_000,
  verifierLength: 1_000,
  evidenceLines: 20,
  evidenceLineLength: 500,
  paths: 200,
  pathLength: 512,
  scopes: 32,
  outcomeLength: 200,
} as const;

/** One task a person's bridge claimed: everything its headless run needs. */
export interface EditTaskSpec {
  readonly taskId: number;
  readonly kind: EditTaskKind;
  /** The identity the run works as. */
  readonly handle: string;
  readonly person: string;
  /** The feature whose work raised the task. */
  readonly feature: string;
  /** The fork the run edits, `feature-<id>`, and its branch. */
  readonly fork: string;
  readonly branch: string;
  /** The files the task names; empty when it names only scopes. */
  readonly paths: readonly string[];
  readonly scopes: readonly string[];
  /** Path prefixes the run's change may touch: the task's files and its scopes' paths. */
  readonly allowed: readonly string[];
  readonly instructions: string;
  /** Which of Penguin's checks verify the edit. */
  readonly verifier: string;
  /** The failing check's lines a next step carries, as the check runner reported them. */
  readonly evidence: readonly string[];
  /** When Penguin takes the task back from this bridge. */
  readonly leaseUntil: string;
  /** For a `fix`: the approved write, made without an agent; null otherwise. */
  readonly fixWrite: FixWriteSpec | null;
  /** For a `review`: the part revision and scope the form covers; null otherwise. */
  readonly review: EditReviewTarget | null;
}

const text = (maxLength: number): JsonSchema => ({ type: "string", maxLength });
const strings = (maxItems: number, maxLength: number): JsonSchema => ({ type: "array", maxItems, items: text(maxLength) });
const objectId: JsonSchema = { type: "string", pattern: "^[0-9a-f]{40}$" };
const projectRepo: JsonSchema = { type: "string", pattern: `^(?:base|feature-${SEGMENT_PATTERN})$`, maxLength: 71 };
const closed = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** JSON Schema of EditReviewTrial: full commit IDs, the base repo or a feature fork, and a bounded patch. */
const REVIEW_TRIAL_SCHEMA: JsonSchema = closed({
  checkpoint: objectId,
  target: closed({ id: text(63), repo: projectRepo, sha: objectId }),
  fix: {
    oneOf: [
      closed({ kind: { const: "commit" }, repo: projectRepo, commit: objectId, base: objectId }),
      closed({ kind: { const: "patch" }, patch: { type: "string", minLength: 1, maxLength: PATCH_LIMITS.bytes } }),
    ],
  },
});

/** JSON Schema of EditTaskSpec; the bridge refuses a claim whose task does not match it. */
export const EDIT_TASK_SPEC_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "kind", "handle", "person", "feature", "fork", "branch", "paths", "scopes", "allowed", "instructions", "verifier", "evidence", "leaseUntil", "fixWrite", "review"],
  properties: {
    taskId: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: [...EDIT_TASK_KINDS] },
    handle: text(IDENTITY_HANDLE_MAX_LENGTH),
    person: text(39),
    feature: text(63),
    fork: { type: "string", pattern: "^feature-[a-z0-9]+(?:[.-][a-z0-9]+)*$", maxLength: 71 },
    branch: text(255),
    paths: strings(EDIT_TASK_LIMITS.paths, EDIT_TASK_LIMITS.pathLength),
    scopes: strings(EDIT_TASK_LIMITS.scopes, 128),
    allowed: strings(EDIT_TASK_LIMITS.paths, EDIT_TASK_LIMITS.pathLength),
    instructions: text(EDIT_TASK_LIMITS.instructionsLength),
    verifier: text(EDIT_TASK_LIMITS.verifierLength),
    evidence: strings(EDIT_TASK_LIMITS.evidenceLines, EDIT_TASK_LIMITS.evidenceLineLength),
    leaseUntil: text(40),
    fixWrite: { oneOf: [{ type: "null" }, FIX_WRITE_SPEC_SCHEMA] },
    review: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["feature", "scope", "part", "revision", "trial"],
          properties: { feature: text(63), scope: text(128), part: text(200), revision: { type: "integer", minimum: 1 }, trial: { oneOf: [{ type: "null" }, REVIEW_TRIAL_SCHEMA] } },
        },
      ],
    },
  },
};

/** The problems of a claimed task, empty when it is an EditTaskSpec. */
export function checkEditTaskSpec(value: unknown): SchemaError[] {
  return checkSchema(EDIT_TASK_SPEC_SCHEMA, value);
}

/**
 * What a bridge reports when a run ends. `commit` is required for `done`, except for a review: its
 * result is the form the run submitted, which Penguin looks up itself.
 */
export interface EditTaskReport {
  readonly status: "done" | "failed" | "timeout";
  /** One line the bridge builds from facts; never the agent's transcript. */
  readonly outcome: string;
  readonly commit?: string;
}

/** A person's queue as views and the bridge show it. */
export interface EditQueue {
  readonly running: number;
  readonly queued: number;
  readonly asked: number;
  /** Background runs the person's bridge may hold at once. */
  readonly cap: number;
}
