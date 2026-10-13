// The six kinds of validation and the review policy that says who decides each (#175, docs/validation.md
// and docs/review-policies.md).
//
// Every check Penguin runs falls under one kind: Tests, Logic, Data matching, Stored data, Protected
// paths and place, Overlapping starts. The dashboard, `get_work`, the signed records and the docs use
// these names.
//
// A review policy is one per sandbox, a Penguin project: its base repo and the forks agents work in.
// For each type of approval it says who decides a part the type's check flags: Penguin, or the person
// the part routes to (`partRouting`). Tests are no type: a failed test always goes back to the agent,
// and Penguin never approves a part whose tests have not passed. A part flagged by several types goes
// to a person when any of them is set to person. Three presets fill the table; a sandbox may change
// single rows after picking one. Production sends every part to a person whatever its rows say, as
// PENGUIN_PLAN_ADMIN_MODE does; that setting locks the policy to Production.

import type { PartRouting, PartRoutingReason } from "./plan-approval.ts";
import type { BlockCheckName } from "./block-check.ts";
import { ruleWrittenRouting, type RuleWrittenRoute } from "./migration.ts";
import { PERSON_ID_MAX_LENGTH, PERSON_ID_PATTERN } from "./operation-schema.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

/** The six kinds of validation, in the order every view lists them. */
export const VALIDATION_KINDS = ["tests", "logic", "data_matching", "stored_data", "protected_paths_and_place", "overlapping_starts"] as const;
export type ValidationKind = (typeof VALIDATION_KINDS)[number];

export const VALIDATION_KIND_LABEL: Readonly<Record<ValidationKind, string>> = {
  tests: "Tests",
  logic: "Logic",
  data_matching: "Data matching",
  stored_data: "Stored data",
  protected_paths_and_place: "Protected paths and place",
  overlapping_starts: "Overlapping starts",
};

/** What each kind checks, in one line. */
export const VALIDATION_KIND_CHECKS: Readonly<Record<ValidationKind, string>> = {
  tests: "The scopes' tests and the block checks pass on the merged tree that holds the fix",
  logic: "The owner's agent fills in a review form saying each declared invariant still holds",
  data_matching: "A side-by-side run of main and the fork gives the same output on each protected invariant's examples",
  stored_data: "A changed stored shape that another scope reads comes with a migration or backfill",
  protected_paths_and_place: "The fix writes no protected path and no file outside the part's scopes",
  overlapping_starts: "A new feature's area does not overlap another person's running feature",
};

/** The policy's rows: one per type of approval. Protected paths and Place are two rows of one kind. */
export const APPROVAL_TYPES = ["logic", "data_matching", "stored_data", "protected_paths", "place", "overlapping_starts"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_TYPE_LABEL: Readonly<Record<ApprovalType, string>> = {
  logic: "Logic",
  data_matching: "Data matching",
  stored_data: "Stored data",
  protected_paths: "Protected paths",
  place: "Place",
  overlapping_starts: "Overlapping starts",
};

export const APPROVAL_TYPE_KIND: Readonly<Record<ApprovalType, ValidationKind>> = {
  logic: "logic",
  data_matching: "data_matching",
  stored_data: "stored_data",
  protected_paths: "protected_paths_and_place",
  place: "protected_paths_and_place",
  overlapping_starts: "overlapping_starts",
};

/** What flags a part or a start under each row, in one line. */
export const APPROVAL_TYPE_FLAG: Readonly<Record<ApprovalType, string>> = {
  logic: "The review form reports an invariant not holding",
  data_matching: "The side-by-side run differs on a protected invariant",
  stored_data: "A changed stored shape has no migration or backfill",
  protected_paths: "The fix touches a path a scope's owner protects",
  place: "The fix reaches outside the part's scopes",
  overlapping_starts: "A feature's start overlaps another person's running feature",
};

export const DECIDERS = ["penguin", "person"] as const;
export type Decider = (typeof DECIDERS)[number];

export const REVIEW_PRESETS = ["throwaway", "dev", "production"] as const;
export type ReviewPreset = (typeof REVIEW_PRESETS)[number];

export const REVIEW_PRESET_LABEL: Readonly<Record<ReviewPreset, string>> = {
  throwaway: "Throwaway",
  dev: "Dev",
  production: "Production",
};

/** A sandbox's review policy: the preset it started from and who decides each type. */
export interface ReviewPolicy {
  readonly preset: ReviewPreset;
  readonly rows: Readonly<Record<ApprovalType, Decider>>;
}

const every = (decider: Decider): Record<ApprovalType, Decider> =>
  Object.fromEntries(APPROVAL_TYPES.map((type) => [type, decider])) as Record<ApprovalType, Decider>;

/**
 * Throwaway: Penguin decides every type and the owners are told. Dev: today's rule, a person decides
 * every flagged part and every overlapping start. Production: a person decides every part.
 */
export const PRESET_POLICIES: Readonly<Record<ReviewPreset, ReviewPolicy>> = {
  throwaway: { preset: "throwaway", rows: every("penguin") },
  dev: { preset: "dev", rows: every("person") },
  production: { preset: "production", rows: every("person") },
};

/** The policy of a sandbox no one has set: Dev, Penguin's rule before policies existed. */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = PRESET_POLICIES.dev;

/** Whether a row differs from the policy's preset. */
export function policyChanged(policy: ReviewPolicy): boolean {
  const preset = PRESET_POLICIES[policy.preset].rows;
  return APPROVAL_TYPES.some((type) => policy.rows[type] !== preset[type]);
}

/** The policy's name: `Dev policy`, or `Dev policy, changed` when a row differs from Dev's. */
export function policyName(policy: ReviewPolicy): string {
  return `${REVIEW_PRESET_LABEL[policy.preset]} policy${policyChanged(policy) ? ", changed" : ""}`;
}

/**
 * Reads a policy from a request or a record: `{ preset, rows }` with every row named once and nothing
 * else. Answers the policy, or a message naming what is wrong.
 */
export function parseReviewPolicy(value: unknown): ReviewPolicy | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the policy must be an object with preset and rows";
  const { preset, rows, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return "the policy takes only preset and rows";
  if (typeof preset !== "string" || !(REVIEW_PRESETS as readonly string[]).includes(preset)) return `preset must be one of ${REVIEW_PRESETS.join(", ")}`;
  if (typeof rows !== "object" || rows === null || Array.isArray(rows)) return "rows must name penguin or person for each type of approval";
  const named = rows as Record<string, unknown>;
  const unknownRow = Object.keys(named).find((key) => !(APPROVAL_TYPES as readonly string[]).includes(key));
  if (unknownRow !== undefined) return `rows name no type ${unknownRow.slice(0, 40)}`;
  const parsed: Partial<Record<ApprovalType, Decider>> = {};
  for (const type of APPROVAL_TYPES) {
    const decider = named[type];
    if (decider !== "penguin" && decider !== "person") return `rows.${type} must be penguin or person`;
    parsed[type] = decider;
  }
  return { preset: preset as ReviewPreset, rows: parsed as Record<ApprovalType, Decider> };
}

/** The policy in force: the stored one, or Production locked while PENGUIN_PLAN_ADMIN_MODE is on. */
export interface PolicyInForce {
  readonly policy: ReviewPolicy;
  /** PENGUIN_PLAN_ADMIN_MODE is on: every part goes to a person and the dashboard cannot change it. */
  readonly locked: boolean;
}

export function policyInForce(stored: ReviewPolicy | undefined, adminMode: boolean): PolicyInForce {
  return adminMode ? { policy: PRESET_POLICIES.production, locked: true } : { policy: stored ?? DEFAULT_REVIEW_POLICY, locked: false };
}

/**
 * A review still to come: waited for, not failed. The same test as plan-approval.ts isWaitingReason,
 * kept here so that module may import this one's schema without a cycle.
 */
function isWaitingReason(reason: PartRoutingReason): boolean {
  return reason.kind === "review" && (reason.state === "missing" || reason.state === "pending" || reason.state === "stale");
}

/** The kind a routing reason's check falls under, or null for a reason no check gives. */
export function reasonKind(reason: PartRoutingReason): ValidationKind | null {
  switch (reason.kind) {
    case "tests":
      return "tests";
    case "review":
    case "broken_invariant":
      return "logic";
    case "protected_difference":
      return "data_matching";
    case "stored_data_unmarked":
      return "stored_data";
    case "protected_path":
    case "outside_place":
      return "protected_paths_and_place";
    case "admin_mode":
    case "reversed":
      return null;
  }
}

/** The type of approval a reason flags, or null for tests, a review still to come and the reasons no check gives. */
export function reasonType(reason: PartRoutingReason): ApprovalType | null {
  if (isWaitingReason(reason)) return null;
  switch (reason.kind) {
    case "review":
    case "broken_invariant":
      return "logic";
    case "protected_difference":
      return "data_matching";
    case "stored_data_unmarked":
      return "stored_data";
    case "protected_path":
      return "protected_paths";
    case "outside_place":
      return "place";
    default:
      return null;
  }
}

/** The kind each block check falls under: every one is a deterministic check on the merged tree but the overlap of writes. */
export function blockCheckKind(check: BlockCheckName): ValidationKind {
  return check === "overlap" ? "overlapping_starts" : "tests";
}

/**
 * Why a part goes where it goes under the policy. `checks_clean`: no check flags it. `set_to_penguin`:
 * each flagged type is set to Penguin. `set_to_person`: `types` are flagged and set to person.
 * `tests`: its tests have not passed. `awaiting_review`: Penguin waits for a review form a row set to
 * person needs. `every_part`: Production. `admin_mode`: PENGUIN_PLAN_ADMIN_MODE. `reversed`: its
 * owner reversed Penguin's approval of this revision.
 */
export const POLICY_RULES = ["checks_clean", "set_to_penguin", "set_to_person", "tests", "awaiting_review", "every_part", "admin_mode", "reversed"] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

export interface PolicyRoute {
  /** `penguin` approves it now; `person` decides it; `waiting` waits for a review form. */
  readonly decider: "penguin" | "person" | "waiting";
  readonly rule: PolicyRule;
  /** The flagged types the rule names: set to person for `set_to_person`, to Penguin for `set_to_penguin`. */
  readonly types: readonly ApprovalType[];
  /** The kinds of every check that flagged the part, tests included. */
  readonly kinds: readonly ValidationKind[];
  readonly preset: ReviewPreset;
  /** A row differs from the preset's. */
  readonly changed: boolean;
  readonly locked: boolean;
}

/** The review form feeds these rows: Penguin waits for a form while one of them is set to person. */
const FORM_TYPES: readonly ApprovalType[] = ["logic", "data_matching", "stored_data"];

function kindsOf(reasons: readonly PartRoutingReason[]): ValidationKind[] {
  const kinds = new Set(reasons.flatMap((reason) => reasonKind(reason) ?? []));
  return VALIDATION_KINDS.filter((kind) => kinds.has(kind));
}

function typesOf(reasons: readonly PartRoutingReason[]): ApprovalType[] {
  const types = new Set(reasons.flatMap((reason) => reasonType(reason) ?? []));
  return APPROVAL_TYPES.filter((type) => types.has(type));
}

/**
 * Who decides a plan part under the policy in force, from its routing (`partRouting`). Under Dev it
 * gives today's rule: Penguin approves exactly the parts with no reason.
 */
export function policyRoute(inForce: PolicyInForce, routing: PartRouting): PolicyRoute {
  const { policy, locked } = inForce;
  const reasons = routing.reasons.filter((reason) => reason.kind !== "admin_mode");
  const base = { preset: policy.preset, changed: policyChanged(policy), locked, kinds: kindsOf(reasons) };
  const route = (decider: PolicyRoute["decider"], rule: PolicyRule, types: readonly ApprovalType[] = []): PolicyRoute => ({ decider, rule, types, ...base });
  if (locked) return route("person", "admin_mode");
  if (reasons.some((reason) => reason.kind === "reversed")) return route("person", "reversed");
  // A failed test goes back to the agent under every policy: Penguin never approves it.
  if (reasons.some((reason) => reason.kind === "tests")) return route("person", "tests");
  if (policy.preset === "production") return route("person", "every_part");
  const flagged = typesOf(reasons);
  const toPerson = flagged.filter((type) => policy.rows[type] === "person");
  if (toPerson.length > 0) return route("person", "set_to_person", toPerson);
  if (reasons.some(isWaitingReason) && FORM_TYPES.some((type) => policy.rows[type] === "person")) return route("waiting", "awaiting_review");
  return flagged.length > 0 ? route("penguin", "set_to_penguin", flagged) : route("penguin", "checks_clean");
}

/**
 * Who decides a rule-written migration part after its trial (`ruleWrittenRouting`). A failing test or
 * a protected invariant that differs goes back to an agent as an edit task, as today. A flagged type
 * set to Penguin no longer stops Penguin. Production and admin mode send a part whose trial passed to
 * a person.
 */
export function migrationPolicyRoute(
  inForce: PolicyInForce,
  reasons: readonly PartRoutingReason[],
): { readonly route: RuleWrittenRoute; readonly reasons: readonly PartRoutingReason[]; readonly policy: PolicyRoute } {
  const { policy, locked } = inForce;
  const counted = reasons.filter((reason) => {
    if (reason.kind === "admin_mode") return false;
    const type = reasonType(reason);
    return type === null || policy.rows[type] === "person";
  });
  const decided = ruleWrittenRouting(counted);
  const base = { preset: policy.preset, changed: policyChanged(policy), locked, kinds: kindsOf(reasons) };
  const flagged = typesOf(reasons);
  if (decided.route === "task") return { ...decided, policy: { decider: "person", rule: "tests", types: [], ...base } };
  if (locked || policy.preset === "production") {
    return { route: "person", reasons: decided.reasons, policy: { decider: "person", rule: locked ? "admin_mode" : "every_part", types: [], ...base } };
  }
  if (decided.route === "person") return { ...decided, policy: { decider: "person", rule: "set_to_person", types: typesOf(decided.reasons), ...base } };
  return { ...decided, policy: { decider: "penguin", rule: flagged.length > 0 ? "set_to_penguin" : "checks_clean", types: flagged, ...base } };
}

/** Who decides an overlapping start under the policy: Penguin approves it at once when the row says so. */
export function startDecider(inForce: PolicyInForce): Decider {
  return inForce.locked || inForce.policy.preset === "production" ? "person" : inForce.policy.rows.overlapping_starts;
}

const joinLabels = (labels: readonly string[]): string =>
  labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

/**
 * The rule as words after the state, as every part shows it: `Dev policy, checks clean`, `Data matching
 * is set to person`.
 */
export function policyRuleText(route: PolicyRoute, owner?: string): string {
  const name = `${REVIEW_PRESET_LABEL[route.preset]} policy${route.changed ? ", changed" : ""}`;
  const types = joinLabels(route.types.map((type) => APPROVAL_TYPE_LABEL[type]));
  const verb = route.types.length > 1 ? "are" : "is";
  switch (route.rule) {
    case "checks_clean":
      return `${name}, checks clean`;
    case "set_to_penguin":
      return `${types} ${verb} set to Penguin`;
    case "set_to_person":
      return `${types} ${verb} set to person`;
    case "tests":
      return "Tests have not passed";
    case "awaiting_review":
      return `${name}, the review form is not in yet`;
    case "every_part":
      return `${name}, every part goes to a person`;
    case "admin_mode":
      return "Admin mode, every part goes to a person";
    case "reversed":
      return `${owner ?? "The owner"} reversed Penguin's approval`;
  }
}

/** The record and API form of a route. */
export const POLICY_ROUTE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decider", "rule", "types", "kinds", "preset", "changed", "locked"],
  properties: {
    decider: { type: "string", enum: ["penguin", "person", "waiting"] },
    rule: { type: "string", enum: [...POLICY_RULES] },
    types: { type: "array", items: { type: "string", enum: [...APPROVAL_TYPES] } },
    kinds: { type: "array", items: { type: "string", enum: [...VALIDATION_KINDS] } },
    preset: { type: "string", enum: [...REVIEW_PRESETS] },
    changed: { type: "boolean" },
    locked: { type: "boolean" },
  },
};

/** A route as a signed record's payload carries it, with snake case keys. */
export function policyRoutePayload(route: PolicyRoute): Record<string, unknown> {
  return { preset: route.preset, changed: route.changed, locked: route.locked, decider: route.decider, rule: route.rule, types: [...route.types], kinds: [...route.kinds] };
}

/** One count of the measured split: parts Penguin approved and parts people approved. */
export interface SplitCount {
  readonly penguin: number;
  readonly people: number;
}

/** The split over the last `days` days, overall and per type of approval that flagged the part. */
export interface ReviewSplit {
  readonly days: number;
  readonly overall: SplitCount;
  readonly byType: Readonly<Record<ApprovalType, SplitCount>>;
}

/** The sandbox's review policy as the dashboard shows it (`GET /api/review-policy`). */
export interface ReviewPolicyView {
  readonly policy: ReviewPolicy;
  readonly locked: boolean;
  /** Who changed it last and when, with the signed record; null while it is the default. */
  readonly changedBy: string | null;
  readonly changedAt: string | null;
  readonly recordId: string | null;
  /** The signed-in person leads a team in penguin/teams.json and the policy is not locked. */
  readonly canChange: boolean;
  readonly split: ReviewSplit;
  /** The split of each team declared in penguin/teams.json: the parts and starts its members own. */
  readonly teams: readonly { readonly team: string; readonly split: ReviewSplit }[];
}

/** The share of `count` Penguin approved, as a whole percent; null with nothing approved. */
export function penguinPercent(count: SplitCount): number | null {
  const total = count.penguin + count.people;
  return total === 0 ? null : Math.round((count.penguin / total) * 100);
}

const PERSON: JsonSchema = { type: "string", pattern: PERSON_ID_PATTERN, maxLength: PERSON_ID_MAX_LENGTH };
const COUNT: JsonSchema = { type: "integer", minimum: 0 };
const SPLIT_COUNT: JsonSchema = { type: "object", additionalProperties: false, required: ["penguin", "people"], properties: { penguin: COUNT, people: COUNT } };
const POLICY: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["preset", "rows"],
  properties: {
    preset: { type: "string", enum: [...REVIEW_PRESETS] },
    rows: {
      type: "object",
      additionalProperties: false,
      required: [...APPROVAL_TYPES],
      properties: Object.fromEntries(APPROVAL_TYPES.map((type) => [type, { type: "string", enum: [...DECIDERS] }])),
    },
  },
};

const SPLIT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["days", "overall", "byType"],
  properties: {
    days: COUNT,
    overall: SPLIT_COUNT,
    byType: { type: "object", additionalProperties: false, required: [...APPROVAL_TYPES], properties: Object.fromEntries(APPROVAL_TYPES.map((type) => [type, SPLIT_COUNT])) },
  },
};

/** JSON Schema of GET /api/review-policy. */
export const REVIEW_POLICY_VIEW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["policy", "locked", "changedBy", "changedAt", "recordId", "canChange", "split", "teams"],
  properties: {
    policy: POLICY,
    locked: { type: "boolean" },
    changedBy: { anyOf: [PERSON, { type: "null" }] },
    changedAt: { anyOf: [{ type: "string", maxLength: 40 }, { type: "null" }] },
    recordId: { anyOf: [{ type: "string", maxLength: 128 }, { type: "null" }] },
    canChange: { type: "boolean" },
    split: SPLIT,
    teams: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["team", "split"], properties: { team: { type: "string", maxLength: 64 }, split: SPLIT } },
    },
  },
};

/** Where an answer breaks REVIEW_POLICY_VIEW_SCHEMA; empty when it conforms. */
export function checkReviewPolicyView(value: unknown): SchemaError[] {
  return checkSchema(REVIEW_POLICY_VIEW_SCHEMA, value);
}

/** The kind each signed record type's result belongs to, when one kind owns the type. */
const RECORD_KIND: Readonly<Record<string, ValidationKind>> = {
  overlap_check: "overlapping_starts",
  approve_overlap: "overlapping_starts",
  block_checked: "tests",
  confirm_protected_change: "protected_paths_and_place",
};

/**
 * The kinds of validation a signed record's result belongs to: the kinds its policy route names, or
 * the one kind that owns its type; empty for a record that carries no check's result.
 */
export function recordValidationKinds(record: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }): ValidationKind[] {
  const route = record.payload["review_policy"];
  const named = typeof route === "object" && route !== null ? (route as { kinds?: unknown }).kinds : undefined;
  if (Array.isArray(named)) return VALIDATION_KINDS.filter((kind) => named.includes(kind));
  const kind = Object.hasOwn(RECORD_KIND, record.type) ? RECORD_KIND[record.type] : undefined;
  return kind === undefined ? [] : [kind];
}

/**
 * How a decision or a write reached Penguin. `agent`: an agent's MCP tool call, named by its identity
 * and the tool. `penguin`: Penguin itself, under the sandbox's policy. `person`: a signed-in person's
 * control on the dashboard.
 */
export const DECISION_ROUTES = ["agent", "penguin", "person"] as const;
export type DecisionRouteKind = (typeof DECISION_ROUTES)[number];

export interface DecisionRoute {
  readonly route: DecisionRouteKind;
  /** The agent's handle, `penguin` or the person. */
  readonly actor: string;
  /** The MCP tool an agent called; null for Penguin and for a person. */
  readonly tool: string | null;
}

/** The MCP tool behind each record type an agent's session writes. */
const RECORD_TOOL: Readonly<Record<string, string>> = {
  open_feature: "open_feature",
  declare_area: "declare_area",
  checkpoint_area: "report_checkpoint",
  propose_plan: "propose_plan",
  plan_returned: "propose_plan",
  retire_symbols: "propose_plan",
  revise_plan_part: "revise_plan_part",
  fix_write: "report_fix_write",
  land_requested: "land_feature",
};

/** A signed record's route, read from its author: `{ identity }`, `{ penguin: true }` or `{ person }`. */
export function recordRoute(record: { readonly type: string; readonly author: unknown }): DecisionRoute {
  const author = (typeof record.author === "object" && record.author !== null ? record.author : {}) as Record<string, unknown>;
  const identity = author["identity"];
  if (typeof identity === "string") {
    return { route: "agent", actor: identity, tool: Object.hasOwn(RECORD_TOOL, record.type) ? (RECORD_TOOL[record.type] as string) : record.type };
  }
  const person = author["person"];
  if (typeof person === "string") return { route: "person", actor: person, tool: null };
  return { route: "penguin", actor: "penguin", tool: null };
}

/** A route as words after the verb: `@priya/accounts-merge (MCP report_fix_write)`, `jun in the dashboard`, `Penguin`. */
export function decisionRouteText(route: DecisionRoute): string {
  if (route.route === "agent") return `${route.actor} (MCP ${route.tool ?? "tool"})`;
  if (route.route === "person") return `${route.actor} in the dashboard`;
  return "Penguin";
}

/** The kinds a part's checks covered: Tests and Protected paths and place always, the form's kinds unless a verify part. */
export function checkedKinds(partKind: string): ValidationKind[] {
  return partKind === "verify" ? ["tests", "protected_paths_and_place"] : ["tests", "logic", "data_matching", "stored_data", "protected_paths_and_place"];
}

/**
 * Penguin's approval in words: `Approved by Penguin (Dev policy: Tests, Logic clean)`, or with the
 * kinds the policy let Penguin decide: `Approved by Penguin (Throwaway policy: Tests clean; Logic set to Penguin)`.
 */
export function penguinApprovalText(route: PolicyRoute, partKind: string): string {
  const name = `${REVIEW_PRESET_LABEL[route.preset]} policy${route.changed ? ", changed" : ""}`;
  const set = route.rule === "set_to_penguin" ? new Set(route.types.map((type) => APPROVAL_TYPE_KIND[type])) : new Set<ValidationKind>();
  const clean = checkedKinds(partKind).filter((kind) => !set.has(kind)).map((kind) => VALIDATION_KIND_LABEL[kind]);
  const parts = [`${joinLabels(clean)} clean`, ...(set.size === 0 ? [] : [`${joinLabels([...set].map((kind) => VALIDATION_KIND_LABEL[kind]))} set to Penguin`])];
  return `Approved by Penguin (${name}: ${parts.join("; ")})`;
}
