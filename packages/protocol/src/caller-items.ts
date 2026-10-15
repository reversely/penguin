// The caller protocol: what happens to each affected caller of a change before its branch can change.
//
// The caller replay (caller-replay.ts) gives each call site of a changed function in a running
// feature one verdict. Penguin keeps one item per running feature and contract the replay reaches, on
// the originating feature's FeatureAgent. Each item follows its verdict's path:
//
// - `unaffected`: Penguin asks the receiving worktree's agent to confirm (`confirmation_requested`),
//   and that agent confirms (`confirmed`).
// - `broken`: the originating agent proposes a fix for the receiving branch (`fix_proposed`), a plan
//   part placed on that feature. The receiving agent approves it (`fix_approved`) or rejects it
//   (`fix_rejected`). Penguin's check runner writes an approved fix into the fork (`written`).
// - `differs`: the originating agent explains the difference. It either revises its own change
//   (`explained`, until the next replay resets the item) or calls the difference expected, which asks
//   for a review (`review_requested`). The receiving agent approves (`approved`) or asks for changes
//   (`changes_requested`).
// - `unknown_reach`: no test reaches the call, so the worktree owner, the receiving feature's person,
//   decides.
//
// An item a later replay on the originating feature's current checkpoint finds with every call
// matching closes as `unaffected` (#208), whatever path it was on, and nobody answers it. So does an
// item whose contract the current checkpoint no longer changes, read from the checkpoint's caller
// list without a replay. A later replay that finds a call differing again reopens it on its verdict's path.
//
// An item whose receiving agent leaves it unanswered past the stage's wait, or that the receiving side
// rejected twice, goes to the worktree owner too. The review policy's stage decides when that person
// sees items at all. Production asks the person after every answer of the receiving agent.
//
// Penguin signs a `caller_item` record for every transition. Only the receiving branch's agent
// confirms, approves or rejects; only the originating agent proposes or explains; only the worktree
// owner or their delegate decides an item sent to them. A write into the receiving fork waits until
// every item there is approved from the receiving side. The originating feature reaches main only once
// every item is `confirmed`, `written`, `approved` or `unaffected`.

import type { CallerVerdict, CallerVerdictKind, ReplayCall, ReplayCallStatus, ReplaySide } from "./caller-replay.ts";
import { FEATURE_ID_MAX_LENGTH } from "./overlap.ts";
import { IDENTITY_HANDLE_MAX_LENGTH, PERSON_ID_MAX_LENGTH, PERSON_ID_PATTERN, SEGMENT_PATTERN } from "./operation-schema.ts";
import type { JsonSchema } from "./schema-check.ts";
import type { ReviewPreset } from "./validation.ts";

export const CALLER_ITEM_STATES = [
  "confirmation_requested",
  "confirmed",
  "broken",
  "fix_proposed",
  "fix_approved",
  "fix_rejected",
  "written",
  "differs",
  "explained",
  "review_requested",
  "approved",
  "changes_requested",
  "unknown_reach",
  "unaffected",
  "withdrawn",
] as const;
export type CallerItemState = (typeof CALLER_ITEM_STATES)[number];

/** The state an item opens in, or returns to when a new replay changes its calls, per verdict. */
export const CALLER_OPENING_STATE: Readonly<Record<CallerVerdictKind, CallerItemState>> = {
  unaffected: "confirmation_requested",
  broken: "broken",
  differs: "differs",
  unknown_reach: "unknown_reach",
};

/**
 * Why the worktree owner decides an item. `unknown_reach`: no test reaches the call. `unanswered`:
 * the receiving agent gave no answer within the stage's wait. `rejected_twice`: the receiving side
 * rejected a fix or asked for changes twice. `policy`: the stage asks the person after every answer.
 */
export const CALLER_OWNER_REASONS = ["unknown_reach", "unanswered", "rejected_twice", "policy"] as const;
export type CallerOwnerReason = (typeof CALLER_OWNER_REASONS)[number];

/** Who acts next on an item. */
export const CALLER_PARTIES = ["receiving_agent", "originating_agent", "worktree_owner", "nobody"] as const;
export type CallerParty = (typeof CALLER_PARTIES)[number];

const RECEIVING: ReadonlySet<CallerItemState> = new Set(["confirmation_requested", "fix_proposed", "review_requested"]);
// An approved fix waits on nobody: Penguin's check runner writes it (#207).
const ORIGINATING: ReadonlySet<CallerItemState> = new Set(["broken", "fix_rejected", "differs", "explained", "changes_requested"]);

/** Who acts next: the worktree owner while the item is sent to them, otherwise by its state. */
export function callerWaitingOn(item: { readonly state: CallerItemState; readonly ownerAsked: CallerOwnerReason | null }): CallerParty {
  if (item.ownerAsked !== null || item.state === "unknown_reach") return "worktree_owner";
  if (RECEIVING.has(item.state)) return "receiving_agent";
  if (ORIGINATING.has(item.state)) return "originating_agent";
  return "nobody";
}

/**
 * States a land accepts. `unaffected`: a re-check on the current checkpoint matched every call, or the
 * checkpoint no longer changes the contract. `withdrawn`: no replay reaches the item any more.
 */
const LAND_STATES: ReadonlySet<CallerItemState> = new Set(["confirmed", "written", "approved", "unaffected", "withdrawn"]);
/** States a write into the receiving fork accepts: the receiving side approved, or nothing changes there. */
const WRITE_STATES: ReadonlySet<CallerItemState> = new Set([...LAND_STATES, "fix_approved"]);

/** Whether the item lets the originating feature land (`land`) or a write into its fork go ahead (`write`). */
export function callerItemSettled(item: { readonly state: CallerItemState; readonly ownerAsked: CallerOwnerReason | null }, purpose: "land" | "write"): boolean {
  if (item.ownerAsked !== null) return false;
  return (purpose === "land" ? LAND_STATES : WRITE_STATES).has(item.state);
}

/**
 * The transitions, each a signed `caller_item` record. `by` names who may make it: Penguin from a
 * replay or a kept write, the receiving agent, the originating agent or the worktree owner.
 */
export const CALLER_ITEM_ACTIONS = [
  "open",
  "reset",
  "withdraw",
  "close",
  "confirm",
  "propose_fix",
  "approve_fix",
  "reject_fix",
  "write",
  "explain",
  "request_review",
  "approve",
  "request_changes",
  "ask_owner",
  "owner_approve",
  "owner_request_changes",
] as const;
export type CallerItemAction = (typeof CALLER_ITEM_ACTIONS)[number];

export const CALLER_ACTION_BY: Readonly<Record<CallerItemAction, "penguin" | "receiving_agent" | "originating_agent" | "worktree_owner">> = {
  open: "penguin",
  reset: "penguin",
  withdraw: "penguin",
  close: "penguin",
  confirm: "receiving_agent",
  propose_fix: "originating_agent",
  approve_fix: "receiving_agent",
  reject_fix: "receiving_agent",
  write: "penguin",
  explain: "originating_agent",
  request_review: "originating_agent",
  approve: "receiving_agent",
  request_changes: "receiving_agent",
  ask_owner: "penguin",
  owner_approve: "worktree_owner",
  owner_request_changes: "worktree_owner",
};

/** The states the worktree owner decides from, once an item is sent to them. */
const OWNER_DECIDES: readonly CallerItemState[] = ["confirmation_requested", "confirmed", "fix_proposed", "fix_approved", "fix_rejected", "review_requested", "approved", "changes_requested", "unknown_reach"];

/** The states each action starts from. */
export const CALLER_ACTION_FROM: Readonly<Partial<Record<CallerItemAction, readonly CallerItemState[]>>> = {
  confirm: ["confirmation_requested"],
  propose_fix: ["broken", "fix_rejected", "fix_proposed"],
  approve_fix: ["fix_proposed"],
  reject_fix: ["fix_proposed"],
  write: ["fix_approved"],
  explain: ["differs", "explained", "changes_requested"],
  request_review: ["explained"],
  approve: ["review_requested"],
  request_changes: ["review_requested"],
  owner_approve: OWNER_DECIDES,
  owner_request_changes: OWNER_DECIDES,
};

/** Where the worktree owner's approval leaves an item: the receiving side's approval on its path. */
export function ownerApproved(state: CallerItemState): CallerItemState {
  if (state === "confirmation_requested" || state === "confirmed") return "confirmed";
  if (state === "fix_proposed" || state === "fix_approved" || state === "fix_rejected") return "fix_approved";
  return "approved";
}

/** Where the worktree owner's request for changes leaves an item. */
export function ownerRequestedChanges(state: CallerItemState): CallerItemState {
  return state === "fix_proposed" || state === "fix_approved" || state === "fix_rejected" ? "fix_rejected" : "changes_requested";
}

/**
 * What each stage of the review policy asks of the worktree owner. `told`: the owner's inbox lists
 * every `broken` and `differs` item as information. `decidesEvery`: the owner decides each item after
 * the receiving agent answers. `waitHours`: how long an item waits on the receiving agent before it
 * goes to the owner.
 */
export interface CallerStage {
  readonly told: boolean;
  readonly decidesEvery: boolean;
  readonly waitHours: number;
}

export const CALLER_STAGES: Readonly<Record<ReviewPreset, CallerStage>> = {
  local_development: { told: false, decidesEvery: false, waitHours: 24 },
  central_development: { told: true, decidesEvery: false, waitHours: 24 },
  pre_production: { told: true, decidesEvery: false, waitHours: 8 },
  production: { told: true, decidesEvery: true, waitHours: 4 },
};

/** Rejections by the receiving side after which the worktree owner decides the item. */
export const CALLER_REJECTION_LIMIT = 2;

export const CALLER_ITEM_LIMITS = {
  /** An explanation, a review note or a fix proposal's note. */
  textLength: 4_000,
  /** One differing call's reason or one piece of evidence. */
  reasonLength: 1_000,
  /** Calls one explanation or review answers. */
  answers: 256,
  /** Refused answers an item keeps until it next moves. */
  refusals: 3,
  /** Items one replay may open for one originating feature. */
  items: 256,
  /** Differing calls a view lists per item. */
  viewCalls: 10,
} as const;

/** An item id: `caller-` and 16 hexadecimal digits of the SHA-256 of its originating feature, receiving feature and contract. */
export const CALLER_ITEM_ID_PATTERN = "^caller-[0-9a-f]{16}$";

/**
 * How the originating agent classifies one differing call. `intended`: the change means the call to
 * differ. `incidental`: the change does not mean it to, so the agent revises the change.
 */
export type CallerCallKind = "intended" | "incidental";

/** The originating agent's classification of one listed differing call, by its replay call id. */
export interface CallerCallClass {
  readonly callId: string;
  readonly kind: CallerCallKind;
  readonly reason: string;
}

/**
 * One answer for the differing calls the replay counted but did not list (a caller's
 * `differingCount` past its listed calls). `count` states their number exactly.
 */
export interface CallerUnlistedClass {
  readonly count: number;
  readonly kind: CallerCallKind;
  readonly reason: string;
}

/** What the originating agent said about a differing item. */
export interface CallerExplanation {
  /** `expected`: the difference is intended, so the receiving agent reviews it. `revising`: the agent changes its own code. */
  readonly kind: "expected" | "revising";
  readonly text: string;
  /** Every listed differing call, classified; absent on an explanation kept before #189. */
  readonly calls?: readonly CallerCallClass[];
  /** The unlisted differing calls as one group; null when the replay listed every one. */
  readonly unlisted?: CallerUnlistedClass | null;
  readonly by: string;
  readonly at: string;
}

/** The plan part revision the originating agent proposes as a broken item's fix. */
export interface CallerFix {
  readonly partId: string;
  readonly revision: number;
  readonly note: string;
  readonly by: string;
  readonly at: string;
}

/**
 * The receiving agent's verdict on one listed differing call. `evidence` is a pytest node id that ran
 * on the merged tree in the item's replay, or a replayed call id of the item.
 */
export interface CallerCallVerdict {
  readonly callId: string;
  readonly verdict: "approve" | "request_changes";
  readonly evidence: string;
}

/** The receiving agent's verdict on the unlisted differing calls as one group, with their exact count. */
export interface CallerUnlistedVerdict {
  readonly count: number;
  readonly verdict: "approve" | "request_changes";
  readonly evidence: string;
}

/** The receiving side's answer: the agent's review, or the worktree owner's decision. */
export interface CallerReview {
  readonly verdict: "approve" | "request_changes";
  readonly text: string;
  /** The agent's verdict per listed differing call; absent for the worktree owner's decision. */
  readonly calls?: readonly CallerCallVerdict[];
  readonly unlisted?: CallerUnlistedVerdict | null;
  readonly by: string;
  readonly at: string;
}

/**
 * Why Penguin refused an agent's answer for want of real evidence (#189):
 *
 * - `run_not_on_item`: `confirm_caller` cites a run that is not the item's replay run.
 * - `run_not_matched`: a call of the cited run did not match.
 * - `call_left_out`: an explanation or a review leaves out a listed differing call.
 * - `call_unknown`: it names a call id the item's replay does not list.
 * - `unlisted_uncounted`: it does not answer the unlisted differing calls with their exact count.
 * - `incidental_to_review`: an explanation sends an incidental difference for review.
 * - `evidence_unknown`: a review cites a test or a call the item's replay did not run.
 * - `evidence_from_change`: a review cites a test the originating change added or edited.
 * - `evidence_not_on_main`: a review cites a test that was neither on main before the change nor
 *   written by the receiving feature.
 */
export const CALLER_REFUSAL_CODES = [
  "run_not_on_item",
  "run_not_matched",
  "call_left_out",
  "call_unknown",
  "unlisted_uncounted",
  "incidental_to_review",
  "evidence_unknown",
  "evidence_from_change",
  "evidence_not_on_main",
] as const;
export type CallerRefusalCode = (typeof CALLER_REFUSAL_CODES)[number];

/** One refused answer, kept on the item until the item next moves. */
export interface CallerRefusal {
  readonly code: CallerRefusalCode;
  readonly by: string;
  readonly at: string;
}

/** Each refusal reason as the dashboard tags it. */
export const CALLER_REFUSAL_LABEL: Readonly<Record<CallerRefusalCode, string>> = {
  run_not_on_item: "Run not from this item",
  run_not_matched: "Run has differing calls",
  call_left_out: "Differing call left out",
  call_unknown: "Call not in the replay",
  unlisted_uncounted: "Unlisted calls not counted",
  incidental_to_review: "Incidental difference sent to review",
  evidence_unknown: "Evidence not in the replay",
  evidence_from_change: "Test written by the change",
  evidence_not_on_main: "Test not on main or this worktree",
};

/** One replay run an item's callers came from, without the recorded values. */
export interface CallerItemRun {
  readonly runId: string;
  /** The functions the run wrapped (CallerReplayRun.symbols); absent on an item kept before #193. */
  readonly symbols?: readonly string[];
  readonly forkCommit: string;
  readonly mergedCommit: string;
  readonly scopes: readonly string[];
  readonly tests: { readonly old: { readonly passed: number; readonly failed: number; readonly errors: number }; readonly new: { readonly passed: number; readonly failed: number; readonly errors: number } };
}

/**
 * A function the replay keeps wrapping while an item that named it is unsettled, even once the
 * originating change no longer modifies it (#193): the run then shows the item's callers `unaffected`.
 */
export interface HeldReplay {
  /** The dotted name the run wrapped, such as `shared.platform.dates.start_of_day`. */
  readonly symbol: string;
  readonly contract: string;
  /** The receiving feature whose tests reach it. */
  readonly feature: string;
}

/** One item: an originating feature's change reaching one contract's callers in one running feature. */
export interface CallerItem {
  readonly itemId: string;
  /** The originating feature, whose FeatureAgent keeps the item. */
  readonly origin: string;
  /** The receiving feature: the worktree whose code calls the contract. */
  readonly feature: string;
  readonly contract: string;
  /** The verdict over the item's callers: the first of broken, differs, unknown_reach and unaffected any caller has. */
  readonly verdict: CallerVerdictKind;
  readonly state: CallerItemState;
  readonly ownerAsked: CallerOwnerReason | null;
  /** Fixes rejected and changes requested by the receiving side, across replays. */
  readonly rejections: number;
  /** The SHA-256 of the verdicts and differing calls: a replay that changes it resets the item. */
  readonly fingerprint: string;
  readonly callers: readonly CallerVerdict[];
  readonly runs: readonly CallerItemRun[];
  /**
   * What last moved the item: the originating agent's `check` run, a block run, or the caller list of
   * a checkpoint that no longer changes the contract (`list`, #208).
   */
  readonly source: { readonly kind: "check" | "block" | "list"; readonly id: string; readonly checkpoint: string };
  readonly explanation: CallerExplanation | null;
  readonly fix: CallerFix | null;
  readonly review: CallerReview | null;
  /** The newest refused answers since the item last moved; absent on an item kept before #189. */
  readonly refusals?: readonly CallerRefusal[];
  readonly openedAt: string;
  readonly updatedAt: string;
  /** The newest `caller_item` record. */
  readonly recordId: string;
}

/** The verdict over several callers: the first of broken, differs, unknown_reach and unaffected any has. */
export function itemVerdict(callers: readonly Pick<CallerVerdict, "verdict">[]): CallerVerdictKind {
  for (const verdict of ["broken", "differs", "unknown_reach"] as const) {
    if (callers.some((caller) => caller.verdict === verdict)) return verdict;
  }
  return "unaffected";
}

/** One side of a differing call as the dashboard shows it: how it ended and its effects, without its values. */
export interface CallerSideView {
  readonly status: ReplayCallStatus;
  /** The exception's type, when it raised. */
  readonly error: string | null;
  readonly effects: readonly string[];
  readonly effectCount: number;
}

/** One item as the dashboard shows it, on the feature page and in the worktree owner's inbox. */
export interface CallerItemView {
  readonly itemId: string;
  readonly origin: string;
  readonly originPerson: string;
  readonly feature: string;
  /** The worktree owner: the receiving feature's person. */
  readonly person: string;
  readonly contract: string;
  readonly verdict: CallerVerdictKind;
  readonly state: CallerItemState;
  readonly waitingOn: CallerParty;
  readonly ownerAsked: CallerOwnerReason | null;
  readonly rejections: number;
  readonly callers: readonly { readonly path: string; readonly line: number; readonly verdict: CallerVerdictKind; readonly calls: number; readonly matched: number; readonly differingCount: number }[];
  readonly differing: readonly {
    readonly callId: string;
    readonly test: string;
    readonly symbol: string;
    readonly differs: readonly string[];
    readonly old: CallerSideView;
    readonly new: CallerSideView;
    /** The originating agent's classification of the call, with its reason. */
    readonly kind: { readonly kind: CallerCallKind; readonly reason: string } | null;
    /** The receiving agent's verdict on the call, with its evidence. */
    readonly verdict: { readonly verdict: CallerCallVerdict["verdict"]; readonly evidence: string } | null;
  }[];
  /** Answers Penguin refused since the item last moved, newest last. */
  readonly refusals: readonly CallerRefusal[];
  readonly explanation: { readonly kind: CallerExplanation["kind"]; readonly text: string; readonly by: string } | null;
  readonly fix: { readonly partId: string; readonly revision: number; readonly note: string } | null;
  readonly review: { readonly verdict: CallerReview["verdict"]; readonly text: string; readonly by: string } | null;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly recordId: string;
}

function sideView(side: ReplaySide): CallerSideView {
  return { status: side.status, error: side.error?.type ?? null, effects: side.effects.map((effect) => effect.summary), effectCount: side.effectCount };
}

/** The dashboard's view of an item: the differing calls' outcomes and effects, never their recorded values. */
export function callerItemView(item: CallerItem, people: { readonly origin: string; readonly feature: string }): CallerItemView {
  const calls: ReplayCall[] = item.callers.flatMap((caller) => caller.differing).slice(0, CALLER_ITEM_LIMITS.viewCalls);
  const kinds = new Map((item.explanation?.calls ?? []).map((each) => [each.callId, { kind: each.kind, reason: each.reason }]));
  const verdicts = new Map((item.review?.calls ?? []).map((each) => [each.callId, { verdict: each.verdict, evidence: each.evidence }]));
  return {
    itemId: item.itemId,
    origin: item.origin,
    originPerson: people.origin,
    feature: item.feature,
    person: people.feature,
    contract: item.contract,
    verdict: item.verdict,
    state: item.state,
    waitingOn: callerWaitingOn(item),
    ownerAsked: item.ownerAsked,
    rejections: item.rejections,
    callers: item.callers.map(({ path, line, verdict, calls: count, matched, differingCount }) => ({ path, line, verdict, calls: count, matched, differingCount })),
    differing: calls.map((call) => ({
      callId: call.callId,
      test: call.test,
      symbol: call.symbol,
      differs: call.differs,
      old: sideView(call.old),
      new: sideView(call.new),
      kind: kinds.get(call.callId) ?? null,
      verdict: verdicts.get(call.callId) ?? null,
    })),
    refusals: item.refusals ?? [],
    explanation: item.explanation === null ? null : { kind: item.explanation.kind, text: item.explanation.text, by: item.explanation.by },
    fix: item.fix === null ? null : { partId: item.fix.partId, revision: item.fix.revision, note: item.fix.note },
    review: item.review === null ? null : { verdict: item.review.verdict, text: item.review.text, by: item.review.by },
    openedAt: item.openedAt,
    updatedAt: item.updatedAt,
    recordId: item.recordId,
  };
}

/** An item in the worktree owner's inbox: `decide` when it is sent to them, `told` when the stage only tells them. */
export interface CallerItemRequest extends CallerItemView {
  readonly ask: "decide" | "told";
}

const text = (maxLength: number, minLength = 0): JsonSchema => ({ type: "string", minLength, maxLength });
const COUNT: JsonSchema = { type: "integer", minimum: 0 };
const FEATURE: JsonSchema = { type: "string", pattern: `^${SEGMENT_PATTERN}$`, maxLength: FEATURE_ID_MAX_LENGTH };
const PERSON: JsonSchema = { type: "string", pattern: PERSON_ID_PATTERN, maxLength: PERSON_ID_MAX_LENGTH };
const record = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const VERDICT: JsonSchema = { type: "string", enum: ["unaffected", "broken", "differs", "unknown_reach"] };
const SIDE: JsonSchema = record({
  status: { type: "string", enum: ["returned", "raised", "missing"] },
  error: nullable(text(256)),
  effects: { type: "array", items: text(500) },
  effectCount: COUNT,
});
const BY: JsonSchema = text(IDENTITY_HANDLE_MAX_LENGTH, 1);

const VIEW_FIELDS = {
  itemId: { type: "string", pattern: CALLER_ITEM_ID_PATTERN },
  origin: FEATURE,
  originPerson: PERSON,
  feature: FEATURE,
  person: PERSON,
  contract: text(1_024, 1),
  verdict: VERDICT,
  state: { type: "string", enum: [...CALLER_ITEM_STATES] },
  waitingOn: { type: "string", enum: [...CALLER_PARTIES] },
  ownerAsked: nullable({ type: "string", enum: [...CALLER_OWNER_REASONS] }),
  rejections: COUNT,
  callers: { type: "array", items: record({ path: text(1_024, 1), line: { type: "integer", minimum: 1 }, verdict: VERDICT, calls: COUNT, matched: COUNT, differingCount: COUNT }) },
  differing: {
    type: "array",
    maxItems: CALLER_ITEM_LIMITS.viewCalls,
    items: record({
      callId: text(64, 1),
      test: text(500, 1),
      symbol: text(512, 1),
      differs: { type: "array", items: text(16) },
      old: SIDE,
      new: SIDE,
      kind: nullable(record({ kind: { type: "string", enum: ["intended", "incidental"] }, reason: text(CALLER_ITEM_LIMITS.reasonLength) })),
      verdict: nullable(record({ verdict: { type: "string", enum: ["approve", "request_changes"] }, evidence: text(CALLER_ITEM_LIMITS.reasonLength) })),
    }),
  },
  refusals: {
    type: "array",
    maxItems: CALLER_ITEM_LIMITS.refusals,
    items: record({ code: { type: "string", enum: [...CALLER_REFUSAL_CODES] }, by: BY, at: text(64, 1) }),
  },
  explanation: nullable(record({ kind: { type: "string", enum: ["expected", "revising"] }, text: text(CALLER_ITEM_LIMITS.textLength), by: BY })),
  fix: nullable(record({ partId: text(128, 1), revision: { type: "integer", minimum: 1 }, note: text(CALLER_ITEM_LIMITS.textLength) })),
  review: nullable(record({ verdict: { type: "string", enum: ["approve", "request_changes"] }, text: text(CALLER_ITEM_LIMITS.textLength), by: BY })),
  openedAt: text(64, 1),
  updatedAt: text(64, 1),
  recordId: text(256, 1),
} satisfies Record<keyof CallerItemView, JsonSchema>;

/** JSON Schema (draft 2020-12) of one CallerItemRequest in the plan inbox. */
export const CALLER_ITEM_REQUEST_SCHEMA: JsonSchema = record({ ...VIEW_FIELDS, ask: { type: "string", enum: ["decide", "told"] } });

/** The words for each state, as the dashboard shows them. */
export const CALLER_STATE_LABEL: Readonly<Record<CallerItemState, string>> = {
  confirmation_requested: "Confirmation requested",
  confirmed: "Confirmed",
  broken: "Broken",
  fix_proposed: "Fix proposed",
  fix_approved: "Fix approved",
  fix_rejected: "Fix rejected",
  written: "Fix written",
  differs: "Differs",
  explained: "Revising",
  review_requested: "Review requested",
  approved: "Approved",
  changes_requested: "Changes requested",
  unknown_reach: "No test reaches it",
  unaffected: "Unaffected",
  withdrawn: "Withdrawn",
};

/** Who an item waits on, as the dashboard names them. */
export const CALLER_PARTY_LABEL: Readonly<Record<CallerParty, string>> = {
  receiving_agent: "Worktree agent",
  originating_agent: "Originating agent",
  worktree_owner: "Worktree owner",
  nobody: "Nobody",
};
