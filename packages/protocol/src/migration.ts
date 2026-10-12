// Migration plans of a split (PRD 0.5 section 4.2 step 2, Migrate): "Penguin proposes migration parts
// for the remaining callers on main and in running features' own changes, grouped by owner. Each
// group goes through sections 4.3 to 4.5 and lands as its own block."
//
// - **One plan per owner group.** After a count of the callers of an originating feature's retiring
//   symbols (retiring-count.ts), each owner group (`migrationGroups`, retiring.ts) becomes one plan
//   of that feature, `migrate:<feature>:<owner>:<n>`. A plan carries only the originating feature's
//   own retiring declarations and their rewrite rules. Each place of the group is one part.
// - **A later caller.** A place found later joins its owner's open plan. When that owner's plan has
//   already landed, the place opens the owner's next plan.
// - **Who writes a part.** The check runner applies the declared rewrite rules to the place's files
//   in a throwaway worktree (`MigrationRewritePlace`). A part is rule-shaped when the rules leave no
//   use of a retiring symbol in the place: the runner wrote its patch. Any other part becomes an
//   edit task (edit-task.ts): the target feature's builder for a running feature's own changes, the
//   steward of the scope's DRI for code on main.
// - **Rule-written parts.** A part the rules write in full is mechanical: it needs no review form.
//   Its trial runs its scopes' tests and, with no form, the side-by-side run over each scope's
//   declared examples. Penguin approves it when the tests pass and no protected invariant differs
//   (`ruleWrittenRouting`). A failing trial makes the part an edit task for the target's builder or
//   steward with the failing check attached; it reaches a person only when that task fails too, or
//   when a check no agent's edit settles fails, such as a protected path.
// - **Written.** An approved part's patch is written into its target fork by the check runner, as a
//   mechanical fix is; an edit task's kept commit is the part's fix. Either makes the part `written`.
// - **The block.** Each plan names its own block feature, which Penguin opens from main for the
//   plan's code on main: `migrate-<owner>-<feature>`, with `-<n>` from the owner's second plan on.
//   A plan whose places are all running features never opens one: it is `closed` once every live
//   part is written into its fork, with nothing to promote. A plan with code on main is `landed`
//   once its block reaches main.
//
// Nothing here runs code; the runner's facts come in as data.

import type { PartRoutingReason } from "./plan-approval.ts";
import type { PlanPlace } from "./plan.ts";
import { checkSchema, type JsonSchema } from "./schema-check.ts";

export const MIGRATION_LIMITS = {
  /** Places one rewrite request names. */
  places: 256,
  /** Files of one place the runner rewrites. */
  files: 200,
  /** Bytes of one place's patch. */
  patchBytes: 256 * 1024,
  /** Characters of an error line. */
  errorLength: 300,
} as const;

/** What the check runner's rewrite of one place gives: the files the rules changed, its patch and the uses left. */
export interface MigrationRewritePlace {
  readonly place: PlanPlace;
  /** `main`, or the running feature whose fork head the rules ran on. */
  readonly target: string;
  /** The commit the rules ran on: main at the count, or the feature's fork head. */
  readonly sha: string;
  /** Each file the rules changed, with the ids of the rules that changed it. */
  readonly files: readonly { readonly path: string; readonly rules: readonly string[] }[];
  /** The rewrite as a unified diff against `sha`, or null when the rules changed nothing. */
  readonly patch: string | null;
  /** Uses of a retiring symbol left in the place once the patch is applied. */
  readonly residual: number;
  /** Why the rules could not run there, or null. */
  readonly error: string | null;
}

/**
 * Where one migration part stands. `rewriting`: the runner's rewrite of the place is asked for.
 * `task`: an edit task is open for its builder or steward. `trial`: the runner wrote the patch and
 * the part's trial runs. `approved`: Penguin approved it and the runner's write of it waits.
 * `written`: its fix is in its target fork. `in_person`: a person decides, because its edit task
 * failed or a check no edit settles failed. `landed`: its plan's block reached main. `dropped`: no
 * caller is left in the place.
 */
export const MIGRATION_PART_STATES = ["rewriting", "task", "trial", "approved", "written", "in_person", "landed", "dropped"] as const;
export type MigrationPartState = (typeof MIGRATION_PART_STATES)[number];

/** `runner` when the declared rules write the whole part; `task` when an agent writes it. */
export type MigrationWriter = "runner" | "task";

/**
 * `open` while a part waits; `approved` once every live part is approved or written; `closed` once
 * every live part of a plan with no code on main is written into its fork; `landed` once its block
 * reached main.
 */
export const MIGRATION_PLAN_STATES = ["open", "approved", "closed", "landed"] as const;
export type MigrationPlanState = (typeof MIGRATION_PLAN_STATES)[number];

export interface MigrationPartView {
  readonly partId: string;
  readonly place: PlanPlace;
  /** The scopes the place's uses fall in. */
  readonly scopes: readonly string[];
  /** Uses of a retiring symbol in the place at the last count. */
  readonly uses: number;
  readonly files: readonly string[];
  /** The retiring contracts the place uses. */
  readonly contracts: readonly string[];
  /** The ids of the declared rules for those contracts. */
  readonly rules: readonly string[];
  readonly writer: MigrationWriter | null;
  /** Why the part has its writer, or why it waits on a person. */
  readonly reason: string | null;
  readonly state: MigrationPartState;
  readonly approvedBy: string | null;
}

export interface MigrationPlanView {
  readonly planId: string;
  /** The originating feature. */
  readonly feature: string;
  readonly owner: string;
  readonly seq: number;
  readonly state: MigrationPlanState;
  /** The feature Penguin opens from main for the plan's block. */
  readonly block: string;
  /** Main's commit at the count that last changed the plan. */
  readonly promotion: string;
  readonly parts: readonly MigrationPartView[];
  readonly recordId: string;
}

/** A place as one key: `scope:<id>` or `feature:<id>`. */
export function migrationPlaceKey(place: PlanPlace): string {
  return place.kind === "scope" ? `scope:${place.scope}` : `feature:${place.feature}`;
}

export function migrationPlanId(feature: string, owner: string, seq: number): string {
  return `migrate:${feature}:${owner}:${seq}`;
}

/** Whether a plan id names a migration plan. */
export function isMigrationPlanId(planId: string): boolean {
  return planId.startsWith("migrate:");
}

const FEATURE_ID_LENGTH = 63;

/** `<prefix>-<feature>`, the feature cut so the id fits a feature id, with a `-<n>` suffix past 1. */
function carrierId(prefix: string, feature: string, seq: number): string {
  const suffix = seq > 1 ? `-${seq}` : "";
  const room = FEATURE_ID_LENGTH - prefix.length - 1 - suffix.length;
  const cut = feature.slice(0, Math.max(room, 1)).replace(/[.-]+$/u, "");
  return `${prefix}-${cut}${suffix}`;
}

/** The feature Penguin opens from main for one migration plan's block. */
export function migrationBlockId(feature: string, owner: string, seq: number): string {
  return carrierId(`migrate-${owner}`, feature, seq);
}

/**
 * The feature Penguin opens from main to carry one contract batch of a feature that is no longer
 * running: `contract-<owner>-<feature>-<package>`, one per DRI and defining package, with a `-<n>`
 * suffix for each later batch of that owner and package, since a carrier is never reused. The package
 * is a directory such as `shared/money`, written `shared-money`; a long feature id is cut first, so
 * the package stays readable.
 */
export function contractCarrierId(feature: string, owner: string, pkg: string, seq = 1): string {
  const prefix = `contract-${owner}`;
  const slug = pkg.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (slug === "") return carrierId(prefix, feature, seq);
  const room = FEATURE_ID_LENGTH - prefix.length - 1 - (seq > 1 ? `-${seq}`.length : 0);
  const cut = feature.slice(0, Math.max(room - slug.length - 1, 1)).replace(/[.-]+$/u, "");
  return carrierId(prefix, `${cut}-${slug}`, seq);
}

/**
 * Who writes a part, from the runner's rewrite of its place: the runner when the rules changed the
 * place and left no use of a retiring symbol; otherwise an agent, with the reason.
 */
export function migrationWriter(rules: readonly string[], rewrite: MigrationRewritePlace | undefined): { readonly writer: MigrationWriter; readonly reason: string } {
  if (rules.length === 0) return { writer: "task", reason: "no rewrite rule is declared for the contracts the place uses" };
  if (rewrite === undefined) return { writer: "task", reason: "the check runner reported no rewrite of the place" };
  if (rewrite.error !== null) return { writer: "task", reason: `the rules could not run: ${rewrite.error}` };
  if (rewrite.patch === null) return { writer: "task", reason: "the declared rules rewrite nothing in the place" };
  if (rewrite.residual > 0) {
    return { writer: "task", reason: `the declared rules leave ${rewrite.residual} use${rewrite.residual === 1 ? "" : "s"} of a retiring symbol in the place` };
  }
  const applied = [...new Set(rewrite.files.flatMap((file) => file.rules))].sort();
  return { writer: "runner", reason: `the rules ${applied.join(", ")} rewrite every use in the place` };
}

/** Where a rule-written part goes after its trial: Penguin approves it, an edit task fixes it, or a person decides. */
export type RuleWrittenRoute = "approve" | "task" | "person";

/**
 * PRD 0.5 section 4.2 step 2 for a part the rules wrote in full, from the routing reasons of PRD 4.3
 * on its trial. It needs no review form, so a missing or pending form is no reason. A failing test,
 * a trial tree that does not hold the patch and a protected invariant the side-by-side run shows
 * differing fail the trial: an edit task fixes the part. Any other reason, such as a protected path,
 * a file outside the place, a form reporting an invariant broken or admin mode, needs a person.
 * Answers the route and the reasons that decide it.
 */
export function ruleWrittenRouting(reasons: readonly PartRoutingReason[]): { readonly route: RuleWrittenRoute; readonly reasons: readonly PartRoutingReason[] } {
  const counted = reasons.filter((reason) => reason.kind !== "review");
  const person = counted.filter((reason) => reason.kind !== "tests" && reason.kind !== "protected_difference");
  if (person.length > 0) return { route: "person", reasons: person };
  if (counted.length > 0) return { route: "task", reasons: counted };
  return { route: "approve", reasons: [] };
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const RULE_ID = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const PLACE: JsonSchema = {
  anyOf: [
    object({ kind: { const: "scope" }, scope: { type: "string", minLength: 1, maxLength: 128 } }),
    object({ kind: { const: "feature" }, feature: { type: "string", minLength: 1, maxLength: 128 } }),
  ],
};

/** JSON Schema of the rewrites a `rewrite` impact result carries. */
export const MIGRATION_REWRITES_SCHEMA: JsonSchema = {
  type: "array",
  maxItems: MIGRATION_LIMITS.places,
  items: object({
    place: PLACE,
    target: { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$", maxLength: 63 },
    sha: SHA,
    files: { type: "array", maxItems: MIGRATION_LIMITS.files, items: object({ path: { type: "string", minLength: 1, maxLength: 1_024 }, rules: { type: "array", maxItems: 32, items: RULE_ID } }) },
    patch: { anyOf: [{ type: "string", maxLength: MIGRATION_LIMITS.patchBytes }, { type: "null" }] },
    residual: { type: "integer", minimum: 0 },
    error: { anyOf: [{ type: "string", maxLength: MIGRATION_LIMITS.errorLength }, { type: "null" }] },
  }),
};

/** Where a list of rewrites breaks MIGRATION_REWRITES_SCHEMA; empty when it holds. */
export function checkMigrationRewrites(value: unknown): string[] {
  return checkSchema(MIGRATION_REWRITES_SCHEMA, value).map((error) => `${error.path || "/"} ${error.message}`);
}
