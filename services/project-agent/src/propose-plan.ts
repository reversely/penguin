// `propose_plan` (PRD 0.4 sections 4.2 and 5.2): an agent of the originating feature submits a merge
// plan, one part per affected place with its proposed diff, and Penguin fills in the facts and
// returns what is missing.
//
// The facts and where each comes from:
// - The change in plain words: the checkpoint commit's subject, read through the Artifacts binding,
//   and the identity whose report recorded the checkpoint (its signed `checkpoint_area` record).
// - The contract diff and the callers: the check runner's impact report (`analysis:python-impact`)
//   on the checkpoint against its baseline, with one fork per running feature (plan-facts.ts).
// - The affected running features: those the impact graph shows using a changed symbol in a file
//   they changed since their merge base with main, or whose tests break on the merged tree. A caller
//   in a file a feature carries unchanged from main is main's; the feature takes that fix with main.
// - Each affected scope's invariants: `penguin/invariants.json` on main.
// - Each break: the failing test's docstring (or its name in words) and the assertion and error
//   lines from the runner's run. On a running feature the runner lists only tests in files it
//   changed since its merge base, or whose traceback passes through its own callers; a failing test
//   in a file it carries unchanged from main is main's break, on main's part.
// - Each part's changed lines. A part for code on main names a commit in the originating fork, whose
//   change against its base Penguin reads through the Artifacts binding, only for files inside the
//   part's scopes. A part for a running feature carries a patch against that feature's fork head;
//   Penguin checks that each hunk applies to the fork's files at that head, read the same way.
//
// Penguin classifies each part's fix as mechanical when every changed line only swaps a name for
// another as a codemod edit the contract diff gives (codemodPlan in @penguin/protocol, the edits the
// resolution ladder's step 3 applies), or when every file it changes is exactly what the plan's
// rewrite rules write there (rewrite-rule.ts): the facts run applies the rules on the check runner and
// reports each file's blob before and after, which Penguin compares with the fix's own blobs. Any
// other fix is behavioural.
//
// A plan may also mark contracts as retiring, each with its replacement (retiring.ts), once its
// expand step has put the replacement beside them. Each must be a declared contract of a scope the
// feature's area names. A rewrite rule may then name a retiring contract the contract diff does not
// touch. A stored plan's retiring symbols become signed project data (retiring-store.ts).
//
// Each part keeps what Penguin's approval checks later (PRD 0.5 section 4.3): the facts run's test
// results for its scopes on its place's merged tree, whether that tree holds the fix, and the files a
// commit changes outside the part's scopes. A plan with more parts needing a person than the project's
// break limit (PRD 4.2 step 4: a part that fails a condition of section 4.3, by partRouting) is
// returned to its author and the originating person gets the exception (PRD section 7). A complete
// plan is signed and kept with every part (plan-store.ts), then sent to every author at once
// (plan-approval.ts). Nothing here calls a model or runs code.

import {
  applyPatchFile,
  codemodPlan,
  needsPerson,
  partRouting,
  type PartReviewResult,
  type PartTestEvidence,
  parseRewriteRules,
  PATCH_LIMITS,
  parsePatch,
  patchMismatch,
  PLAN_BREAK_LIMIT_DEFAULT,
  PLAN_LIMITS,
  PLAN_MAIN_TARGET,
  PLAN_SCHEMA_VERSION,
  parseRetiring,
  placeLabel,
  planId as makePlanId,
  testNameWords,
  type Author,
  type ImpactReport,
  type ImpactUse,
  type Plan,
  type PlanAffectedFeature,
  type PlanBreakFact,
  type PlanFactSource,
  type PlanFacts,
  type PlanFactsReport,
  type PlanFileDiff,
  type PlanInvariantFact,
  type PlanPart,
  type PlanPartKind,
  type PlanPlace,
  type PlanRewriteReport,
  type RetiringDeclaration,
  type RetiringSymbol,
  type RewriteRule,
} from "@penguin/protocol";
import { InvariantsFileError, parseInvariantsBytes, scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRejection, FeatureRejectReason } from "./feature-open.ts";
import { parseFeatureId, type Feature, type FeatureRecord, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import type { FeatureDependent } from "./overlap-lock.ts";
import { protectedLookup } from "./part-checks.ts";
import { factsRequest, type PlanFactsRun, type PlanFactsStore } from "./plan-facts.ts";
import type { PlanKeeper } from "./plan-store.ts";
import { changedFiles, commitSubject, fileDiffs, splitLines, type ChangedFile, type GitObjectReader } from "./repo-diff.ts";
import type { SessionOutcome } from "./session-store.ts";

/** Reads one Artifacts repo through the binding for the length of `use`. */
export type RepoReading = <T>(repo: string, use: (reader: GitObjectReader) => Promise<T>) => Promise<T>;

export interface ProposePlanDeps {
  readonly features: FeatureStore;
  readonly facts: PlanFactsStore;
  /** The plan store of one feature: its Durable Object (plan-store.ts). */
  readonly keeper: (featureId: string) => PlanKeeper;
  readonly scopeMap: () => Promise<ScopeMap>;
  /** `penguin/invariants.json` on the base repo's branch, or null when there is none. */
  readonly invariantsFile: () => Promise<Uint8Array | null>;
  /** The feature's dependents the overlap check stored. */
  readonly dependents: (featureId: string) => readonly FeatureDependent[];
  readonly readRepo: RepoReading;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** The project's break limit; undefined when its configuration is invalid. */
  readonly breakLimit: number | undefined;
  /**
   * What the break limit's routing reads beyond the plan: the reviews submitted on the feature so far
   * and the project's admin mode. Absent, no review is known and admin mode is off.
   */
  readonly evidence?: (featureId: string) => { readonly reviews: readonly PartReviewResult[]; readonly adminMode: boolean };
  /** Tells the originating person that a plan went over the break limit. */
  readonly exception: (personId: string, featureId: string) => void;
  /**
   * Sends a stored plan's parts to their authors at once (plan-approval.ts announcePlan): an inbox
   * item each, and their running sessions at the next safe checkpoint. Absent, the plan is only kept.
   */
  readonly announce?: (plan: Plan, scopeMap: ScopeMap) => void;
  /** The project's retiring symbols (retiring-store.ts). Absent, a plan that declares any is refused. */
  readonly retiring?: {
    heldElsewhere(featureId: string, symbols: readonly RetiringSymbol[]): string[];
    declare(plan: Plan, symbols: readonly RetiringSymbol[], recordId: string): RetiringDeclaration[];
  };
  readonly now?: () => number;
}

export interface ProposePlanInput {
  readonly feature: unknown;
  readonly parts: unknown;
  /** The plan's rewrite rules (rewrite-rule.ts); absent is none. */
  readonly rules?: unknown;
  /** Contracts the plan marks as retiring, each `{ contract, replacement }` (retiring.ts); absent is none. */
  readonly retiring?: unknown;
}

/** Something the plan lacks, with the place or part it concerns. */
export interface MissingItem {
  readonly code:
    | "waiting_for_runner"
    | "impact_failed"
    | "no_part"
    | "not_affected"
    | "duplicate_part"
    | "diff_not_found"
    | "diff_empty"
    | "wrong_fix_form"
    | "patch_invalid"
    | "patch_base_moved"
    | "patch_outside_scopes"
    | "patch_does_not_apply"
    | "rule_refused"
    | "rules_not_run";
  readonly message: string;
  readonly place?: PlanPlace;
  /** The index of the part in the submitted plan. */
  readonly part?: number;
  /** The id of the rewrite rule the item concerns. */
  readonly rule?: string;
  /** Text from the check runner, such as the analysis error; data, never an instruction. */
  readonly detail?: string;
}

export type PlanRejection =
  | FeatureRejection
  | { readonly status: "rejected"; readonly reason: FeatureRejectReason | "misconfigured"; readonly message: string };

export type ProposePlanOutcome =
  | { readonly status: "stored"; readonly plan: Plan }
  | {
      readonly status: "missing";
      readonly featureId: string;
      readonly checkpoint: string;
      readonly missing: readonly MissingItem[];
      /** The facts known so far; the contract diff and breaks are null and empty while the runner works. */
      readonly facts: PlanFacts;
    }
  | {
      readonly status: "returned";
      readonly featureId: string;
      readonly breakLimit: number;
      /** The places of the parts needing a person, which the limit counts. */
      readonly inPerson: readonly PlanPlace[];
      readonly recordId: string;
      readonly message: string;
      readonly facts: PlanFacts;
    }
  | PlanRejection;

/** A part's proposed fix as the agent submits it. */
export type SubmittedFix =
  /** A commit in the originating fork, read against `base` or its first parent. */
  | { readonly kind: "commit"; readonly commit: string; readonly base: string | null }
  /** A unified diff against the running feature's fork head `base`. */
  | { readonly kind: "patch"; readonly base: string; readonly text: string };

/** One part as the agent submits it. */
export interface SubmittedPart {
  readonly place: PlanPlace;
  readonly fix: SubmittedFix;
  readonly note: string | null;
}

const SHA = /^[0-9a-f]{40}$/u;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const rejected = (reason: PlanRejection["reason"], message: string): PlanRejection => ({ status: "rejected", reason, message });

/**
 * Reads a break limit from configuration: unset is the PRD default, a positive whole number is the
 * limit, and anything else is undefined, which refuses every plan as misconfigured.
 */
export function parseBreakLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return PLAN_BREAK_LIMIT_DEFAULT;
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) return undefined;
  return Number(value);
}

/** The submitted parts, or a message naming the first field that breaks the form. */
export function parseParts(value: unknown): SubmittedPart[] | string {
  if (!Array.isArray(value)) return "parts must be an array";
  if (value.length > PLAN_LIMITS.parts) return `a plan holds at most ${PLAN_LIMITS.parts} parts`;
  const parts: SubmittedPart[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `parts[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${at} must be an object`;
    const fields = raw as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !["place", "diff", "patch", "note"].includes(key))) return `${at} takes only place, diff, patch and note`;
    const place = parsePlace(fields["place"]);
    if (place === undefined) return `${at}.place must be { scope: <scope id> } or { feature: <feature id> }`;
    const fix = parseFixFields(place, fields, at);
    if (typeof fix === "string") return fix;
    parts.push({ place, ...fix });
  }
  return parts;
}

/**
 * A part's fix and note for `place`, as `propose_plan` and `revise_plan_part` take them: `diff` for
 * code on main, `patch` for a running feature, and an optional note. A message naming the first field
 * that breaks the form otherwise.
 */
export function parseFixFields(place: PlanPlace, fields: Record<string, unknown>, at: string): { fix: SubmittedFix; note: string | null } | string {
  const fix = place.kind === "scope" ? parseCommitFix(fields, at) : parsePatchFix(fields, at);
  if (typeof fix === "string") return fix;
  const note = fields["note"];
  if (note !== undefined && (typeof note !== "string" || note.length > PLAN_LIMITS.noteLength)) {
    return `${at}.note must be text of at most ${PLAN_LIMITS.noteLength} characters`;
  }
  return { fix, note: typeof note === "string" ? note : null };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Code on main: `diff: { commit, base? }`, a commit in the originating fork. */
function parseCommitFix(fields: Record<string, unknown>, at: string): SubmittedFix | string {
  if (fields["patch"] !== undefined) return `${at}: a part for code on main takes diff, a commit in your fork, not a patch`;
  const diff = fields["diff"];
  if (!isRecord(diff)) return `${at}.diff must be { commit, base? }`;
  const { commit, base, ...rest } = diff;
  if (Object.keys(rest).length > 0) return `${at}.diff takes only commit and base`;
  if (typeof commit !== "string" || !SHA.test(commit)) return `${at}.diff.commit must be a full 40-character SHA`;
  if (base !== undefined && (typeof base !== "string" || !SHA.test(base))) return `${at}.diff.base must be a full 40-character SHA`;
  return { kind: "commit", commit, base: typeof base === "string" ? base : null };
}

/** A running feature: `patch: { base, diff }`, a unified diff against that feature's fork head. */
function parsePatchFix(fields: Record<string, unknown>, at: string): SubmittedFix | string {
  if (fields["diff"] !== undefined) return `${at}: a part for a running feature takes patch, a diff against that feature's fork head`;
  const patch = fields["patch"];
  if (!isRecord(patch)) return `${at}.patch must be { base, diff }`;
  const { base, diff, ...rest } = patch;
  if (Object.keys(rest).length > 0) return `${at}.patch takes only base and diff`;
  if (typeof base !== "string" || !SHA.test(base)) return `${at}.patch.base must be the feature's fork head as a full 40-character SHA`;
  if (typeof diff !== "string" || diff.length === 0 || diff.length > PATCH_LIMITS.bytes) {
    return `${at}.patch.diff must be a unified diff of at most ${PATCH_LIMITS.bytes} bytes`;
  }
  return { kind: "patch", base, text: diff };
}

function parsePlace(value: unknown): PlanPlace | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 1) return undefined;
  if (typeof fields["scope"] === "string" && SCOPE_ID.test(fields["scope"])) return { kind: "scope", scope: fields["scope"] };
  const feature = parseFeatureId(fields["feature"]);
  return feature === undefined ? undefined : { kind: "feature", feature };
}

const placeKey = (place: PlanPlace): string => (place.kind === "scope" ? `scope:${place.scope}` : `feature:${place.feature}`);

/** The checkpoint's baseline on main and who reported it, from its signed `checkpoint_area` record. */
function checkpointRecord(features: FeatureStore, feature: Feature): { baseline: string; madeBy: string } | undefined {
  const records = features.records(feature.id).map((stored) => JSON.parse(stored.file) as FeatureRecord);
  const found = records.reverse().find((record) => record.type === "checkpoint_area" && record.payload["checkpoint"] === feature.latestCheckpointSha);
  const baseline = found?.payload["baseline"];
  if (found === undefined || typeof baseline !== "string") return undefined;
  return { baseline, madeBy: authorLabel(found.author) };
}

function authorLabel(author: Author): string {
  if ("identity" in author) return author.identity;
  if ("person" in author) return author.person;
  return "penguin";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A place the facts show the change reaches, with its scopes, callers and breaks. */
export interface AffectedPlace {
  readonly place: PlanPlace;
  readonly owner: string;
  /** A running feature's fork head the facts run tested, or null for code on main. */
  readonly head: string | null;
  readonly scopes: Set<string>;
  readonly callers: ImpactUse[];
  readonly breaks: PlanBreakFact[];
}

export function breakFacts(report: PlanFactsReport): PlanBreakFact[] {
  return report.results.flatMap((result) =>
    result.breaks.map((each) => ({
      target: result.target,
      scopeId: result.scopeId,
      commandId: result.commandId,
      nodeId: each.nodeId,
      statement: each.docstring ?? testNameWords(each.nodeId),
      statementFrom: each.docstring === null ? ("test_name" as const) : ("docstring" as const),
      assertion: each.assertion,
      error: each.error,
      fingerprint: result.fingerprint?.id ?? null,
    })),
  );
}

/**
 * The places the change reaches. Code on main: each scope outside the changed scopes with a caller on
 * main or a break on the main target. Unfinished work: each running feature whose own changes use a
 * changed symbol or hold an unreadable file in its scopes, or that breaks on its merged tree. The
 * facts run reports a fork's uses only in files it changed since its merge base with main.
 */
export function affectedPlaces(
  impact: ImpactReport,
  breaks: readonly PlanBreakFact[],
  scopeMap: ScopeMap,
  features: FeatureStore,
  heads: ReadonlyMap<string, string>,
): AffectedPlace[] {
  const changed = new Set(impact.changes.flatMap((change) => (change.scope === null ? [] : [change.scope])));
  const places = new Map<string, AffectedPlace>();
  const scopePlace = (scope: string): AffectedPlace | undefined => {
    const owner = scopeMap.scopes.get(scope)?.ownerId;
    if (owner === undefined || changed.has(scope)) return undefined;
    const key = `scope:${scope}`;
    const place = places.get(key) ?? { place: { kind: "scope", scope }, owner, head: null, scopes: new Set([scope]), callers: [], breaks: [] };
    places.set(key, place);
    return place;
  };
  for (const use of impact.headUses) if (use.scope !== null) scopePlace(use.scope)?.callers.push(use);
  for (const each of breaks) if (each.target === PLAN_MAIN_TARGET) scopePlace(each.scopeId)?.breaks.push(each);

  const featurePlace = (featureId: string): AffectedPlace | undefined => {
    const feature = features.get(featureId);
    const head = heads.get(featureId);
    if (feature === undefined || head === undefined) return undefined;
    const key = `feature:${featureId}`;
    const place = places.get(key) ?? {
      place: { kind: "feature", feature: featureId },
      owner: feature.personId,
      head,
      scopes: new Set<string>(),
      callers: [],
      breaks: [],
    };
    places.set(key, place);
    return place;
  };
  for (const fork of impact.forks) {
    if (fork.uses.length === 0 && fork.errors.length === 0) continue;
    const place = featurePlace(fork.id);
    if (place === undefined) continue;
    for (const use of fork.uses) {
      place.callers.push(use);
      if (use.scope !== null) place.scopes.add(use.scope);
    }
    if (fork.errors.length > 0) for (const scope of fork.scopes) place.scopes.add(scope);
  }
  for (const each of breaks) {
    if (each.target === PLAN_MAIN_TARGET) continue;
    const place = featurePlace(each.target);
    place?.breaks.push(each);
    place?.scopes.add(each.scopeId);
  }
  return [...places.values()].sort((a, b) => (placeKey(a.place) < placeKey(b.place) ? -1 : 1));
}

/**
 * Why running feature `featureId` is not a place, from the impact report: its area reads no scope the
 * change touches, or its own changes call nothing in the contract diff. Callers in files it carries
 * unchanged from main are main's, and it takes main's fix with main.
 */
export function unaffectedReason(impact: ImpactReport | null, featureId: string): string {
  const fork = impact?.forks.find((each) => each.id === featureId);
  if (fork === undefined) return "its area reads no scope the change touches";
  const carried = fork.carried ?? 0;
  if (carried === 0) return "its own changes call nothing in the contract diff and none of its tests breaks on the merged tree";
  return (
    `its own changes since its merge base with main call nothing in the contract diff; ` +
    `its ${carried} caller${carried === 1 ? "" : "s"} sit in files it carries unchanged from main, which main's fix covers when it takes main`
  );
}

/**
 * The name swaps a mechanical fix may make in `target` (a fork id, or null for main's own callers):
 * exactly the codemod edits the contract diff gives there, the edits the resolution ladder's step 3
 * applies. A rename or move swaps each dotted segment that differs; a renamed keyword swaps its name.
 */
function allowedSwaps(impact: ImpactReport, target: string | null): Map<string, Set<string>> {
  const swaps = new Map<string, Set<string>>();
  const allow = (from: string, to: string): void => {
    if (from === to) return;
    const set = swaps.get(from) ?? new Set<string>();
    set.add(to);
    swaps.set(from, set);
  };
  for (const edit of codemodPlan(impact, target).edits) {
    if (edit.kind === "rename-parameter") {
      allow(edit.from, edit.to);
      continue;
    }
    const from = edit.from.split(".");
    const to = edit.to.split(".");
    allow(from.at(-1) as string, to.at(-1) as string);
    if (from.length === to.length) from.forEach((segment, index) => allow(segment, to[index] as string));
  }
  return swaps;
}

/** The fork id a place's codemod edits apply in: the running feature's id, or null for code on main. */
export function classifyFixPlace(place: PlanPlace): string | null {
  return place.kind === "feature" ? place.feature : null;
}

const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\s+|./gu;

/**
 * Mechanical when every changed line pairs with a new line that differs from it only by names a
 * codemod edit of the contract diff swaps in `target` (PRD 5.3 step 3: a rename, a move or a renamed
 * keyword); behavioural otherwise, with the first line that shows why.
 */
export function classifyFix(files: readonly PlanFileDiff[], impact: ImpactReport, target: string | null): { kind: PlanPartKind; reason: string } {
  const swaps = allowedSwaps(impact, target);
  const used = new Set<string>();
  for (const file of files) {
    if (file.omitted !== null || file.status !== "modified") {
      return { kind: "behavioural", reason: `${file.path} is ${file.omitted === null ? file.status : "not shown as text"}` };
    }
    for (const hunk of file.hunks) {
      let line = hunk.newStart;
      let index = 0;
      while (index < hunk.lines.length) {
        const text = hunk.lines[index] as string;
        if (text.startsWith(" ")) {
          index += 1;
          line += 1;
          continue;
        }
        const removed: string[] = [];
        const added: string[] = [];
        while (index < hunk.lines.length && (hunk.lines[index] as string).startsWith("-")) removed.push((hunk.lines[index++] as string).slice(1));
        while (index < hunk.lines.length && (hunk.lines[index] as string).startsWith("+")) added.push((hunk.lines[index++] as string).slice(1));
        if (removed.length !== added.length) {
          const lines = (count: number): string => `${count} line${count === 1 ? "" : "s"}`;
          return { kind: "behavioural", reason: `${file.path}:${line} turns ${lines(removed.length)} into ${lines(added.length)}` };
        }
        for (const [offset, before] of removed.entries()) {
          const swapped = swappedSymbols(before, added[offset] as string, swaps);
          if (swapped === undefined) {
            return { kind: "behavioural", reason: `${file.path}:${line + offset} changes more than a codemod edit of the contract diff swaps` };
          }
          for (const pair of swapped) used.add(pair);
        }
        line += added.length;
      }
    }
  }
  if (used.size === 0) return { kind: "behavioural", reason: "the diff makes no codemod edit of the contract diff" };
  return { kind: "mechanical", reason: `every changed line only swaps ${[...used].sort().join(", ")}, a codemod edit of the contract diff` };
}

function swappedSymbols(before: string, after: string, swaps: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length !== b.length) return undefined;
  const pairs: string[] = [];
  for (const [index, token] of a.entries()) {
    const other = b[index] as string;
    if (token === other) continue;
    if (!swaps.get(token)?.has(other)) return undefined;
    pairs.push(`${token} for ${other}`);
  }
  return pairs;
}

/** Each file a fix changes, by its blob before and after; null where the file is absent. */
export type FixImage = ReadonlyMap<string, { readonly before: string | null; readonly after: string | null }>;

/** The facts run's target whose rewritten files a place's fix is compared with. */
export const rewriteTarget = (place: PlanPlace): string => (place.kind === "feature" ? place.feature : PLAN_MAIN_TARGET);

/**
 * Mechanical when every file inside the place's scopes that the fix or the plan's rules change is
 * changed by both, from the same blob to the same blob; behavioural otherwise, with the first file
 * that shows why. Null when the rules did not run in the place, so the name-swap reason stands.
 */
export function classifyByRules(
  image: FixImage,
  rewrites: PlanRewriteReport | null | undefined,
  place: PlanPlace,
  inside: (path: string) => boolean,
): { kind: PlanPartKind; reason: string } | null {
  const ran = rewrites?.places.find((each) => each.target === rewriteTarget(place));
  if (ran === undefined || ran.error !== null || image.size === 0) return null;
  const written = new Map(ran.files.filter((file) => inside(file.path)).map((file) => [file.path, file]));
  const used = new Set<string>();
  for (const path of [...new Set([...image.keys(), ...written.keys()])].sort()) {
    const fix = image.get(path);
    const rule = written.get(path);
    if (fix === undefined) return { kind: "behavioural", reason: `the plan's rules also change ${path}, which the fix leaves as it is` };
    if (rule === undefined) return { kind: "behavioural", reason: `${path} changes where the plan's rules change nothing` };
    if (fix.before !== rule.before) return { kind: "behavioural", reason: `${path} at the fix's base is not the file the plan's rules rewrote` };
    if (fix.after !== rule.after) return { kind: "behavioural", reason: `${path} differs from what the plan's rules write` };
    for (const id of rule.rules) used.add(id);
  }
  return { kind: "mechanical", reason: `every changed file is what the plan's rules write (${[...used].join(", ")})` };
}

/**
 * A part's kind: mechanical by the contract diff's name swaps (classifyFix), or by the plan's rewrite
 * rules (classifyByRules). When rules ran in the place, a behavioural part gives the rules' reason.
 */
export function classifyPart(
  read: FixReading,
  impact: ImpactReport,
  place: PlanPlace,
  rules: readonly RewriteRule[],
  rewrites: PlanRewriteReport | null | undefined,
  inside: (path: string) => boolean,
): { kind: PlanPartKind; reason: string } {
  const named = classifyFix(read.diff.files, impact, classifyFixPlace(place));
  if (named.kind === "mechanical" || rules.length === 0) return named;
  return classifyByRules(read.image, rewrites, place, inside) ?? named;
}

/**
 * Whether the contract diff touches `contract` (`path::symbol`): a declared contract it lists, or a
 * changed module-level symbol of that file.
 */
function contractTouched(impact: ImpactReport, contract: string, retiring: ReadonlySet<string>): boolean {
  if (impact.contracts.includes(contract) || retiring.has(contract)) return true;
  const [path, symbol] = contract.split("::") as [string, string];
  return impact.changes.some((change) => change.path === path && change.symbol.split(".").at(-1) === symbol);
}

/** Every reason the plan's rules may not apply: a contract outside the diff, or the runner's refusals. */
function ruleProblems(rules: readonly RewriteRule[], impact: ImpactReport, report: PlanFactsReport, retiring: ReadonlySet<string>): MissingItem[] {
  if (rules.length === 0) return [];
  const problems: MissingItem[] = [];
  for (const rule of rules) {
    if (!contractTouched(impact, rule.contract, retiring)) {
      problems.push({
        code: "rule_refused",
        rule: rule.id,
        message: `rule ${rule.id} migrates ${rule.contract}, which the contract diff does not touch and the plan does not retire, so it would rewrite code outside the change`,
      });
    }
  }
  if (report.rewrites == null) {
    problems.push({ code: "rules_not_run", message: "the check runner did not apply the plan's rewrite rules; it may predate them" });
    return problems;
  }
  for (const each of report.rewrites.refused) problems.push({ code: "rule_refused", rule: each.rule, message: `rule ${each.rule}: ${each.message}` });
  return problems;
}

/** A path inside one of `scopes`. */
function inScopes(scopeMap: ScopeMap, scopes: ReadonlySet<string>): (path: string) => boolean {
  return (path) => {
    const scope = scopeForPath(scopeMap, path);
    return scope !== undefined && scopes.has(scope);
  };
}

/** Counts each read made through a reader, for the facts' sources. */
export function counted(reader: GitObjectReader, calls: Record<string, number>): GitObjectReader {
  const count = (method: string) => (calls[method] = (calls[method] ?? 0) + 1);
  return {
    readCommit: (hash) => (count("readCommit"), reader.readCommit(hash)),
    readTree: (hash) => (count("readTree"), reader.readTree(hash)),
    readBlob: (hash) => (count("readBlob"), reader.readBlob(hash)),
  };
}

/**
 * Takes a merge plan from `caller`'s session for feature `input.feature`, which the session works on.
 * Answers `missing` with every gap, `returned` over the break limit, or `stored` with the signed plan.
 */
export async function proposePlan(deps: ProposePlanDeps, caller: string, sessionId: string, input: ProposePlanInput): Promise<ProposePlanOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature ${featureId}`);
  if (feature.personId !== caller || deps.features.featureOfSession(sessionId) !== featureId) {
    return rejected("forbidden", `only an agent of feature ${featureId} proposes its plan`);
  }
  if (deps.breakLimit === undefined) return rejected("misconfigured", "PENGUIN_PLAN_BREAK_LIMIT must be a positive whole number");
  const parts = parseParts(input.parts);
  if (typeof parts === "string") return rejected("invalid", parts);
  const rules = parseRewriteRules(input.rules);
  if (typeof rules === "string") return rejected("invalid", rules);
  const retiring = parseRetiring(input.retiring);
  if (typeof retiring === "string") return rejected("invalid", retiring);
  if (retiring.length > 0 && deps.retiring === undefined) return rejected("misconfigured", "this project keeps no retiring symbols");
  if (feature.repo === null || feature.latestCheckpointSha === null) {
    return rejected("not_found", `feature ${featureId} has no checkpoint on its fork; report one before its plan`);
  }
  const checkpoint = feature.latestCheckpointSha;
  const recorded = checkpointRecord(deps.features, feature);
  if (recorded === undefined) return rejected("not_found", `no checkpoint record for ${checkpoint}`);
  const repo = feature.repo;

  const scopeMap = await deps.scopeMap();
  const outsideArea = retiringOutsideArea(retiring, feature, scopeMap);
  if (outsideArea !== undefined) return rejected("invalid", outsideArea);
  const held = retiring.length === 0 ? [] : (deps.retiring?.heldElsewhere(featureId, retiring) ?? []);
  if (held.length > 0) return rejected("conflict", `another feature already retires ${held.join(", ")}`);
  let invariantsFile;
  try {
    invariantsFile = parseInvariantsBytes(await deps.invariantsFile(), scopeMap);
  } catch (error) {
    if (error instanceof InvariantsFileError) return rejected("invalid", error.message);
    throw error;
  }
  const calls: Record<string, number> = {};
  const subject = await deps.readRepo(repo, async (reader) => (await counted(reader, calls).readCommit(checkpoint))?.message);
  if (subject === undefined) return rejected("not_found", `commit ${checkpoint} is not in feature ${featureId}'s fork`);

  // The run carries the plan's rules: other rules than the last run's need a run of their own.
  const run =
    deps.facts.forCheckpoint(featureId, checkpoint, rules) ??
    deps.facts.schedule(factsRequest(feature, recorded.baseline, scopeMap, deps.features.list(), deps.dependents(featureId), rules));
  const report = run.state === "reported" ? run.report : null;
  const breaks = report === null ? [] : breakFacts(report);
  const heads = new Map(run.request.targets.filter((target) => target.id !== PLAN_MAIN_TARGET).map((target) => [target.id, target.sha]));
  const places = report?.impact == null ? [] : affectedPlaces(report.impact, breaks, scopeMap, deps.features, heads);
  const invariantsOf = (scopes: Iterable<string>): PlanInvariantFact[] => {
    const wanted = new Set(scopes);
    return invariantsFile.invariants
      .filter((invariant) => wanted.has(invariant.scopeId))
      .map(({ scopeId, id, statement, protected: isProtected }) => ({ scopeId, id, statement, protected: isProtected }));
  };
  const factsBase = {
    change: { checkpoint, baseline: recorded.baseline, subject: clip(commitSubject(subject), PLAN_LIMITS.subjectLength), madeBy: recorded.madeBy },
    places,
    breaks,
    invariants: invariantsOf(places.flatMap((place) => [...place.scopes])),
    run,
  };

  if (report === null) {
    const facts = planFacts(factsBase, null, deps.dependents(featureId), calls);
    const waiting = { code: "waiting_for_runner" as const, message: `the check runner has not reported facts run ${run.runId}: the contract diff, callers and breaks; propose the plan again once it has` };
    return { status: "missing", featureId, checkpoint, missing: [waiting], facts };
  }
  if (report.impact === null) {
    const facts = planFacts(factsBase, report, deps.dependents(featureId), calls);
    const failed = { code: "impact_failed" as const, message: "the impact analysis failed on the check runner, so the contract diff is missing", detail: report.impactError ?? "" };
    return { status: "missing", featureId, checkpoint, missing: [failed], facts };
  }
  const impact = report.impact;

  const missing: MissingItem[] = ruleProblems(rules, impact, report, new Set(retiring.map((each) => each.contract)));
  const byPlace = new Map(places.map((place) => [placeKey(place.place), place]));
  const claimed = new Map<string, number>();
  for (const [index, part] of parts.entries()) {
    const key = placeKey(part.place);
    if (claimed.has(key)) missing.push({ code: "duplicate_part", part: index, place: part.place, message: `parts ${claimed.get(key)} and ${index} both name ${placeLabel(part.place)}` });
    else claimed.set(key, index);
    if (!byPlace.has(key)) {
      const why = part.place.kind === "feature" ? unaffectedReason(impact, part.place.feature) : "the facts show no caller or break there";
      missing.push({ code: "not_affected", part: index, place: part.place, message: `${placeLabel(part.place)} is not affected: ${why}` });
    }
  }
  for (const place of places) {
    if (!claimed.has(placeKey(place.place))) {
      missing.push({ code: "no_part", place: place.place, message: `${placeLabel(place.place)} is affected and has no part` });
    }
  }

  const built: PlanPart[] = [];
  const version = (await deps.keeper(featureId).planVersion(featureId)) + 1;
  const id = makePlanId(featureId, version);
  for (const [index, part] of parts.entries()) {
    const place = byPlace.get(placeKey(part.place));
    if (place === undefined || claimed.get(placeKey(part.place)) !== index) continue;
    const read = await readFix(deps, part, place, repo, scopeMap, calls, checkpoint);
    if ("code" in read) {
      missing.push({ ...read, part: index, place: part.place });
      continue;
    }
    const { diff } = read;
    const kind = classifyPart(read, impact, place.place, rules, report.rewrites, inScopes(scopeMap, place.scopes));
    built.push({
      partId: `${id}#${index + 1}`,
      place: place.place,
      owner: place.owner,
      scopes: [...place.scopes].sort(),
      kind: kind.kind,
      kindReason: kind.reason,
      diff,
      callers: place.callers,
      breaks: place.breaks,
      invariants: invariantsOf(place.scopes),
      note: part.note,
      revision: 1,
      approvalState: "pending",
      approvedBy: null,
      changeRequests: 0,
      changeRequest: null,
      tests: testEvidence(report, run.runId, place, read.fixInTree),
      reversal: null,
    });
  }
  const facts = planFacts(factsBase, report, deps.dependents(featureId), calls);
  // The limit counts the parts that fail a condition of PRD 4.3 now; a review still to come is waited for.
  const evidence = deps.evidence?.(featureId) ?? { reviews: [], adminMode: false };
  const lookup = protectedLookup(scopeMap);
  const inPerson = built
    .filter((part) => needsPerson(partRouting(part, { reviews: evidence.reviews, checkpoint, adminMode: evidence.adminMode }, lookup)))
    .map((part) => part.place);
  if (inPerson.length > deps.breakLimit) {
    const record = await deps.sign(
      deps.features.draftRecord(featureId, "plan_returned", { identity: live.session.handle }, {
        checkpoint,
        break_limit: deps.breakLimit,
        in_person: inPerson.map(placeLabel),
      }),
    );
    deps.features.addRecord(record);
    deps.exception(feature.personId, featureId);
    const message = `the plan has ${inPerson.length} parts needing a person, over the project's break limit of ${deps.breakLimit}; split or restructure it`;
    return { status: "returned", featureId, breakLimit: deps.breakLimit, inPerson, recordId: record.record_id, message, facts };
  }
  if (missing.length > 0) return { status: "missing", featureId, checkpoint, missing, facts };

  const assembledMs = now() - started;
  const proposedAt = new Date(now()).toISOString();
  const draft = deps.features.draftRecord(featureId, "propose_plan", { identity: live.session.handle }, {
    plan_id: id,
    version,
    checkpoint,
    facts_run: run.runId,
    break_limit: deps.breakLimit,
    rules: rules.map((rule) => rule.id),
    ...(retiring.length === 0 ? {} : { retiring: retiring.map((each) => ({ ...each })) }),
    parts: built.map((part) => ({ part_id: part.partId, place: part.place, kind: part.kind, diff: part.diff.ref })),
  });
  const plan: Plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: id,
    featureId,
    version,
    state: "proposed",
    person: feature.personId,
    proposedBy: live.session.handle,
    proposedAt,
    recordId: draft.record_id,
    breakLimit: deps.breakLimit,
    facts,
    rules,
    ...(retiring.length === 0 ? {} : { retiring }),
    parts: built,
    assembledMs,
  };
  const record = await deps.sign(draft);
  if (!(await deps.keeper(featureId).keepPlan(plan))) {
    return rejected("conflict", `plan version ${version} of feature ${featureId} was kept by another proposal; propose again`);
  }
  deps.features.addRecord(record);
  if (retiring.length > 0 && deps.retiring !== undefined) {
    const retire = await deps.sign(
      deps.features.draftRecord(featureId, "retire_symbols", { identity: live.session.handle }, {
        plan_id: id,
        symbols: retiring.map((each) => ({ ...each, rules: rules.filter((rule) => rule.contract === each.contract).map((rule) => rule.id) })),
      }),
    );
    deps.features.addRecord(retire);
    deps.retiring.declare(plan, retiring, retire.record_id);
  }
  deps.announce?.(plan, scopeMap);
  return { status: "stored", plan };
}

/**
 * Why the plan may not retire one of its symbols, or undefined: each must be a contract
 * `penguin/scopes.json` declares for a scope the feature's area names.
 */
function retiringOutsideArea(retiring: readonly RetiringSymbol[], feature: Feature, scopeMap: ScopeMap): string | undefined {
  for (const each of retiring) {
    const scope = [...scopeMap.scopes.values()].find((candidate) => candidate.contracts.includes(each.contract));
    if (scope === undefined) return `${each.contract} is not a contract in penguin/scopes.json`;
    if (!feature.area.scopes.includes(scope.id)) return `${each.contract} belongs to scope ${scope.id}, which feature ${feature.id}'s area does not name`;
  }
  return undefined;
}

/** How a plan names a part's fix: the commit, or the patch's base and the patch's SHA-256. */
async function fixRef(repo: string, fix: SubmittedFix): Promise<string> {
  if (fix.kind === "commit") return `${repo}@${fix.commit}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fix.text)));
  return `${repo}@${fix.base}+patch:sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A part's fix as read: the plan's view of it, and each file's blobs for the comparison with the rules. */
export interface FixReading {
  readonly diff: PlanPart["diff"];
  readonly image: FixImage;
  /** Whether the plan's checkpoint holds the fix: a commit at or under it. Never for a patch. */
  readonly fixInTree: boolean;
}

export type FixRead = FixReading | { readonly code: MissingItem["code"]; readonly message: string };

/** The most changed files outside a part's scopes a part names; the routing needs only that there is one. */
const OUTSIDE_LIMIT = 20;

/** Commits an ancestry search from the checkpoint visits before it says the fix is not under it. */
const FIX_ANCESTRY_LIMIT = 500;

/**
 * Whether `commit` is `head` or one of its ancestors, searching at most FIX_ANCESTRY_LIMIT commits.
 * A search that runs out answers false, so Penguin never counts an unseen fix as tested.
 */
async function holdsCommit(reader: GitObjectReader, head: string, commit: string): Promise<boolean> {
  const queue = [head];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < FIX_ANCESTRY_LIMIT) {
    const hash = queue.shift() as string;
    if (hash === commit) return true;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const read = await reader.readCommit(hash);
    if (read !== null) queue.push(...read.parents);
  }
  return false;
}

/** The facts run's results for a part's scopes on its place's merged tree. */
export function testEvidence(report: PlanFactsReport, runId: string, place: AffectedPlace, fixInTree: boolean): PartTestEvidence {
  const target = rewriteTarget(place.place);
  const results = report.results
    .filter((result) => result.target === target && place.scopes.has(result.scopeId))
    .map(({ scopeId, commandId, status, breaks }) => ({ scopeId, commandId, status, breaks: breaks.length }));
  return { target, runId, fixInTree, results };
}

/**
 * Reads and checks one part's fix through the binding, only inside the place's scopes. With
 * `checkpoint`, a commit fix is also looked for under the checkpoint the facts run tested.
 */
export async function readFix(
  deps: Pick<ProposePlanDeps, "readRepo" | "features">,
  part: SubmittedPart,
  place: AffectedPlace,
  originRepo: string,
  scopeMap: ScopeMap,
  calls: Record<string, number>,
  checkpoint?: string,
): Promise<FixRead> {
  const inside = inScopes(scopeMap, place.scopes);
  const scopes = [...place.scopes].join(", ");
  if (part.fix.kind === "commit") {
    if (place.place.kind === "feature") return { code: "wrong_fix_form", message: "a part for a running feature carries a patch against its fork head" };
    const fix = part.fix;
    const read = await deps.readRepo(originRepo, async (reader) => {
      const counting = counted(reader, calls);
      const diff = await readCommitDiff(counting, fix.commit, fix.base, scopeMap, inside);
      const held = diff !== undefined && checkpoint !== undefined && (await holdsCommit(counting, checkpoint, fix.commit));
      return diff === undefined ? undefined : { ...diff, held };
    });
    if (read === undefined) return { code: "diff_not_found", message: `commit ${fix.commit} or its base is not in the feature's fork` };
    if (read.files.length === 0) return { code: "diff_empty", message: `the diff changes no file in ${scopes}` };
    const repo = originRepo.slice(originRepo.indexOf("feature-"));
    const image = new Map(read.changed.map((file) => [file.path, { before: file.oldHash, after: file.newHash }]));
    const diff = { source: "commit" as const, repo, ref: await fixRef(repo, fix), commit: fix.commit, base: read.base, patch: null, files: read.files, truncated: read.truncated, outside: read.outside };
    return { diff, image, fixInTree: read.held };
  }
  if (place.place.kind === "scope" || place.head === null) return { code: "wrong_fix_form", message: "a part for code on main names a commit in your fork" };
  const fix = part.fix;
  if (fix.base !== place.head) {
    return { code: "patch_base_moved", message: `the patch must apply to ${place.place.feature}'s fork head ${place.head}, the commit the facts run tested` };
  }
  const parsed = parsePatch(fix.text);
  if (!parsed.ok) return { code: "patch_invalid", message: parsed.message };
  const outside = parsed.files.find((file) => !inside(file.path));
  if (outside !== undefined) return { code: "patch_outside_scopes", message: `${outside.path} lies outside ${scopes}` };
  const target = deps.features.get(place.place.feature);
  if (target?.repo == null) return { code: "patch_does_not_apply", message: `${place.place.feature} has no fork` };
  const image = new Map<string, { before: string | null; after: string | null }>();
  const mismatch = await deps.readRepo(target.repo, async (reader) => {
    const counting = counted(reader, calls);
    const head = await counting.readCommit(fix.base);
    if (head === null) return `${fix.base} is not in ${place.place.kind === "feature" ? place.place.feature : ""}'s fork`;
    for (const file of parsed.files) {
      const before = await fileEntry(counting, head.treeHash, file.path);
      const problem = patchMismatch(file, before === null ? null : splitLines(before.text));
      if (problem !== null) return problem;
      const applied = applyPatchFile(file, before?.text ?? null);
      if (!applied.ok) return applied.message;
      const width = before?.hash.length ?? head.hash.length;
      image.set(file.path, { before: before?.hash ?? null, after: applied.text === null ? null : await blobHash(applied.text, width) });
    }
    return null;
  });
  if (mismatch !== null) return { code: "patch_does_not_apply", message: mismatch };
  const files = parsed.files.map((file) => ({ ...file, scopeId: scopeForPath(scopeMap, file.path) ?? null }));
  const repo = `feature-${place.place.feature}`;
  // Every file of a patch lies inside the place's scopes, or it was refused above.
  return { diff: { source: "patch", repo, ref: await fixRef(repo, fix), commit: null, base: fix.base, patch: fix.text, files, truncated: false, outside: [] }, image, fixInTree: false };
}

/**
 * The object ID of a blob holding `text`: SHA-1, or SHA-256 for a repository whose IDs are 64 hex
 * digits, of the header `blob <size>` and a NUL followed by the bytes.
 */
export async function blobHash(text: string, width: number): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest(width === 64 ? "SHA-256" : "SHA-1", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A file's blob and text at a tree, walking one directory at a time, or null when it is absent. */
async function fileEntry(reader: GitObjectReader, tree: string, path: string): Promise<{ hash: string; text: string } | null> {
  let current = tree;
  const segments = path.split("/");
  for (const [index, name] of segments.entries()) {
    const entry = (await reader.readTree(current))?.find((each) => each.name === name);
    if (entry === undefined) return null;
    if (index < segments.length - 1) {
      if (entry.type !== "tree") return null;
      current = entry.hash;
      continue;
    }
    if (entry.type === "tree") return null;
    const blob = await reader.readBlob(entry.hash);
    return blob === null ? null : { hash: entry.hash, text: await blob.text() };
  }
  return null;
}

/** The files inside the part's scopes that differ between a commit's base (default: its first parent) and the commit. */
async function readCommitDiff(
  reader: GitObjectReader,
  commit: string,
  baseSha: string | null,
  scopeMap: ScopeMap,
  inside: (path: string) => boolean,
): Promise<{ base: string | null; files: PlanFileDiff[]; changed: ChangedFile[]; truncated: boolean; outside: string[] } | undefined> {
  const head = await reader.readCommit(commit);
  if (head === null) return undefined;
  const from = baseSha ?? head.parents[0] ?? null;
  const base = from === null ? null : await reader.readCommit(from);
  if (from !== null && base === null) return undefined;
  // Only files inside the part's scopes are read: a blob outside them is never fetched, only named.
  const changed = await changedFiles(reader, base?.treeHash ?? null, head.treeHash);
  const files = changed.filter((file) => inside(file.path));
  const outside = changed.filter((file) => !inside(file.path)).slice(0, OUTSIDE_LIMIT).map((file) => file.path);
  const diffs = await fileDiffs(reader, files, (path) => scopeForPath(scopeMap, path) ?? null);
  return { base: from, files: diffs.files, changed: files, truncated: diffs.truncated, outside };
}

interface FactsBase {
  readonly change: PlanFacts["change"];
  readonly places: readonly AffectedPlace[];
  readonly breaks: readonly PlanBreakFact[];
  readonly invariants: readonly PlanInvariantFact[];
  readonly run: PlanFactsRun;
}

/**
 * The breaks source in words: the failing tests the plan lists, and the ones running features carry
 * unchanged from main, which are main's breaks and not repeated on a feature's part.
 */
function breaksDetail(breaks: number, trees: number, report: PlanFactsReport): string {
  const listed = `${breaks} failing tests on ${trees} merged trees`;
  const carried = report.results.reduce((sum, result) => sum + (result.carried ?? 0), 0);
  if (carried === 0) return listed;
  return `${listed}; ${carried} more fail on running features in files they carry unchanged from main, which are main's breaks`;
}

/** The plan's facts, with the tool or read each came from. */
function planFacts(
  base: FactsBase,
  report: PlanFactsReport | null,
  dependents: readonly FeatureDependent[],
  calls: Readonly<Record<string, number>>,
): PlanFacts {
  const impact = report?.impact ?? null;
  const dependsOn = new Map<string, Set<string>>();
  for (const each of dependents) {
    const scopes = dependsOn.get(each.dependentFeatureId) ?? new Set<string>();
    scopes.add(each.providerScopeId);
    dependsOn.set(each.dependentFeatureId, scopes);
  }
  const affectedFeatures: PlanAffectedFeature[] = base.places.flatMap((place) =>
    place.place.kind === "feature"
      ? [
          {
            feature: place.place.feature,
            person: place.owner,
            head: place.head ?? "",
            scopes: [...place.scopes].sort(),
            uses: place.callers.length,
            breaks: place.breaks.length,
            dependsOn: [...(dependsOn.get(place.place.feature) ?? [])].sort(),
          },
        ]
      : [],
  );
  const request = base.run.request;
  const affected = new Set(affectedFeatures.map((each) => each.feature));
  const unaffected = impact === null ? [] : request.targets.filter((target) => target.id !== PLAN_MAIN_TARGET && !affected.has(target.id));
  const commands = [...new Set(request.targets.flatMap((target) => target.commandIds))].sort();
  const reads = Object.entries(calls)
    .map(([method, count]) => `${method} ${count}`)
    .join(", ");
  const sources: PlanFactSource[] = [
    { fact: "change", tool: "Artifacts readCommit", detail: `the subject of ${base.change.checkpoint} in feature-${request.feature}; reported by ${base.change.madeBy}` },
    {
      fact: "contract_diff",
      tool: "python-impact (analysis:python-impact)",
      detail: impact === null ? `waiting for facts run ${base.run.runId}` : `${impact.base}..${impact.head} on the check runner, facts run ${base.run.runId}`,
    },
    {
      fact: "callers",
      tool: "python-impact (analysis:python-impact)",
      detail: impact === null ? "waiting" : `${impact.headUses.length} uses on main; ${impact.forks.reduce((sum, fork) => sum + fork.uses.length, 0)} in running features`,
    },
    {
      fact: "affected_features",
      tool: "python-impact forks, test runs and scope dependencies",
      detail: [
        `${request.targets.length - 1} running features checked, ${affectedFeatures.length} affected`,
        ...unaffected.map((target) => `${target.id} is not affected: ${unaffectedReason(impact, target.id)}`),
      ].join(". "),
    },
    { fact: "invariants", tool: "penguin/invariants.json on main", detail: `${base.invariants.length} invariants of the affected scopes` },
    {
      fact: "breaks",
      tool: commands.length === 0 ? "no test command" : commands.join(", "),
      detail: report === null ? "waiting" : breaksDetail(base.breaks.length, request.targets.length, report),
    },
    { fact: "changed_lines", tool: "Artifacts readCommit, readTree, readBlob", detail: reads === "" ? "no reads" : reads },
  ];
  return {
    change: base.change,
    contractDiff:
      impact === null
        ? null
        : {
            base: impact.base,
            head: impact.head,
            complete: impact.complete,
            contracts: impact.contracts,
            changes: impact.changes,
            signatures: impact.signatures,
            removedExports: impact.removedExports,
            dataShapes: impact.dataShapes,
          },
    mainCallers: impact?.headUses ?? [],
    affectedFeatures,
    invariants: base.invariants,
    breaks: base.breaks,
    sources,
    run:
      report === null || base.run.reportedAt === null
        ? null
        : { runId: base.run.runId, durationMs: report.durationMs, reportedAt: base.run.reportedAt },
  };
}
