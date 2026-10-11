// `propose_plan` (PRD 0.4 sections 4.2 and 5.2): an agent of the originating feature submits a merge
// plan, one part per affected place with its proposed diff, and Penguin fills in the facts and
// returns what is missing.
//
// The facts and where each comes from:
// - The change in plain words: the checkpoint commit's subject, read through the Artifacts binding,
//   and the identity whose report recorded the checkpoint (its signed `checkpoint_area` record).
// - The contract diff and the callers: the check runner's impact report (`analysis:python-impact`)
//   on the checkpoint against its baseline, with one fork per running feature (plan-facts.ts).
// - The affected running features: those the impact graph shows using a changed symbol, or whose
//   tests break on the merged tree.
// - Each affected scope's invariants: `penguin/invariants.json` on main.
// - Each break: the failing test's docstring (or its name in words) and the assertion and error
//   lines from the runner's run.
// - Each part's changed lines. A part for code on main names a commit in the originating fork, whose
//   change against its base Penguin reads through the Artifacts binding, only for files inside the
//   part's scopes. A part for a running feature carries a patch against that feature's fork head;
//   Penguin checks that each hunk applies to the fork's files at that head, read the same way.
//
// Penguin classifies each part's fix as mechanical when every changed line only swaps a name for
// another as a codemod edit the contract diff gives (codemodPlan in @penguin/protocol, the edits the
// resolution ladder's step 3 applies), and behavioural otherwise. A plan whose behavioural parts
// outnumber the project's break limit is returned to its author and the originating person gets the
// exception (PRD section 7). A complete plan is signed and kept with
// every part (plan-store.ts). Nothing here calls a model or runs code.

import {
  codemodPlan,
  PATCH_LIMITS,
  parsePatch,
  patchMismatch,
  PLAN_BREAK_LIMIT_DEFAULT,
  PLAN_LIMITS,
  PLAN_MAIN_TARGET,
  PLAN_SCHEMA_VERSION,
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
} from "@penguin/protocol";
import { InvariantsFileError, parseInvariantsBytes, scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRejection, FeatureRejectReason } from "./feature-open.ts";
import { parseFeatureId, type Feature, type FeatureRecord, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import type { FeatureDependent } from "./overlap-lock.ts";
import { factsRequest, type PlanFactsRun, type PlanFactsStore } from "./plan-facts.ts";
import type { PlanKeeper } from "./plan-store.ts";
import { changedFiles, commitSubject, fileDiffs, splitLines, type GitObjectReader } from "./repo-diff.ts";
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
  /** Tells the originating person that a plan went over the break limit. */
  readonly exception: (personId: string, featureId: string) => void;
  readonly now?: () => number;
}

export interface ProposePlanInput {
  readonly feature: unknown;
  readonly parts: unknown;
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
    | "patch_does_not_apply";
  readonly message: string;
  readonly place?: PlanPlace;
  /** The index of the part in the submitted plan. */
  readonly part?: number;
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
      /** The places of the behavioural parts, the fixes an agent writes, which the limit counts. */
      readonly behavioural: readonly PlanPlace[];
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
    const fix = place.kind === "scope" ? parseCommitFix(fields, at) : parsePatchFix(fields, at);
    if (typeof fix === "string") return fix;
    const note = fields["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > PLAN_LIMITS.noteLength)) {
      return `${at}.note must be text of at most ${PLAN_LIMITS.noteLength} characters`;
    }
    parts.push({ place, fix, note: typeof note === "string" ? note : null });
  }
  return parts;
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
interface AffectedPlace {
  readonly place: PlanPlace;
  readonly owner: string;
  /** A running feature's fork head the facts run tested, or null for code on main. */
  readonly head: string | null;
  readonly scopes: Set<string>;
  readonly callers: ImpactUse[];
  readonly breaks: PlanBreakFact[];
}

function breakFacts(report: PlanFactsReport): PlanBreakFact[] {
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
 * main or a break on the main target. Unfinished work: each running feature whose fork uses a changed
 * symbol, holds an unreadable file in its scopes, or breaks on its merged tree.
 */
function affectedPlaces(
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

/** A path inside one of `scopes`. */
function inScopes(scopeMap: ScopeMap, scopes: ReadonlySet<string>): (path: string) => boolean {
  return (path) => {
    const scope = scopeForPath(scopeMap, path);
    return scope !== undefined && scopes.has(scope);
  };
}

/** Counts each read made through a reader, for the facts' sources. */
function counted(reader: GitObjectReader, calls: Record<string, number>): GitObjectReader {
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
  if (feature.repo === null || feature.latestCheckpointSha === null) {
    return rejected("not_found", `feature ${featureId} has no checkpoint on its fork; report one before its plan`);
  }
  const checkpoint = feature.latestCheckpointSha;
  const recorded = checkpointRecord(deps.features, feature);
  if (recorded === undefined) return rejected("not_found", `no checkpoint record for ${checkpoint}`);
  const repo = feature.repo;

  const scopeMap = await deps.scopeMap();
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

  const run = deps.facts.forCheckpoint(featureId, checkpoint) ?? deps.facts.schedule(factsRequest(feature, recorded.baseline, scopeMap, deps.features.list(), deps.dependents(featureId)));
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

  const missing: MissingItem[] = [];
  const byPlace = new Map(places.map((place) => [placeKey(place.place), place]));
  const claimed = new Map<string, number>();
  for (const [index, part] of parts.entries()) {
    const key = placeKey(part.place);
    if (claimed.has(key)) missing.push({ code: "duplicate_part", part: index, place: part.place, message: `parts ${claimed.get(key)} and ${index} both name ${placeLabel(part.place)}` });
    else claimed.set(key, index);
    if (!byPlace.has(key)) missing.push({ code: "not_affected", part: index, place: part.place, message: `the facts show no caller or break in ${placeLabel(part.place)}` });
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
    const read = await readFix(deps, part, place, repo, scopeMap, calls);
    if ("code" in read) {
      missing.push({ ...read, part: index, place: part.place });
      continue;
    }
    const diff = read;
    const kind = classifyFix(diff.files, impact, place.place.kind === "feature" ? place.place.feature : null);
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
      approvalState: "pending",
      approvedBy: null,
    });
  }
  const facts = planFacts(factsBase, report, deps.dependents(featureId), calls);
  // The limit counts the fixes an agent writes; Penguin's codemod writes the mechanical ones.
  const behavioural = built.filter((part) => part.kind === "behavioural").map((part) => part.place);
  if (behavioural.length > deps.breakLimit) {
    const record = await deps.sign(
      deps.features.draftRecord(featureId, "plan_returned", { identity: live.session.handle }, {
        checkpoint,
        break_limit: deps.breakLimit,
        behavioural: behavioural.map(placeLabel),
      }),
    );
    deps.features.addRecord(record);
    deps.exception(feature.personId, featureId);
    const message = `the plan has ${behavioural.length} behavioural parts, over the project's break limit of ${deps.breakLimit}; split or restructure it`;
    return { status: "returned", featureId, breakLimit: deps.breakLimit, behavioural, recordId: record.record_id, message, facts };
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
    parts: built,
    assembledMs,
  };
  const record = await deps.sign(draft);
  if (!(await deps.keeper(featureId).keepPlan(plan))) {
    return rejected("conflict", `plan version ${version} of feature ${featureId} was kept by another proposal; propose again`);
  }
  deps.features.addRecord(record);
  return { status: "stored", plan };
}

/** How a plan names a part's fix: the commit, or the patch's base and the patch's SHA-256. */
async function fixRef(repo: string, fix: SubmittedFix): Promise<string> {
  if (fix.kind === "commit") return `${repo}@${fix.commit}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fix.text)));
  return `${repo}@${fix.base}+patch:sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type FixRead = PlanPart["diff"] | { readonly code: MissingItem["code"]; readonly message: string };

/** Reads and checks one part's fix through the binding, only inside the place's scopes. */
async function readFix(
  deps: ProposePlanDeps,
  part: SubmittedPart,
  place: AffectedPlace,
  originRepo: string,
  scopeMap: ScopeMap,
  calls: Record<string, number>,
): Promise<FixRead> {
  const inside = inScopes(scopeMap, place.scopes);
  const scopes = [...place.scopes].join(", ");
  if (part.fix.kind === "commit") {
    if (place.place.kind === "feature") return { code: "wrong_fix_form", message: "a part for a running feature carries a patch against its fork head" };
    const fix = part.fix;
    const read = await deps.readRepo(originRepo, (reader) => readCommitDiff(counted(reader, calls), fix.commit, fix.base, scopeMap, inside));
    if (read === undefined) return { code: "diff_not_found", message: `commit ${fix.commit} or its base is not in the feature's fork` };
    if (read.files.length === 0) return { code: "diff_empty", message: `the diff changes no file in ${scopes}` };
    const repo = originRepo.slice(originRepo.indexOf("feature-"));
    return { source: "commit", repo, ref: await fixRef(repo, fix), commit: fix.commit, base: read.base, patch: null, files: read.files, truncated: read.truncated };
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
  const mismatch = await deps.readRepo(target.repo, async (reader) => {
    const counting = counted(reader, calls);
    const head = await counting.readCommit(fix.base);
    if (head === null) return `${fix.base} is not in ${place.place.kind === "feature" ? place.place.feature : ""}'s fork`;
    for (const file of parsed.files) {
      const problem = patchMismatch(file, await fileLines(counting, head.treeHash, file.path));
      if (problem !== null) return problem;
    }
    return null;
  });
  if (mismatch !== null) return { code: "patch_does_not_apply", message: mismatch };
  const files = parsed.files.map((file) => ({ ...file, scopeId: scopeForPath(scopeMap, file.path) ?? null }));
  const repo = `feature-${place.place.feature}`;
  return { source: "patch", repo, ref: await fixRef(repo, fix), commit: null, base: fix.base, patch: fix.text, files, truncated: false };
}

/** A file's lines at a tree, walking one directory at a time, or null when it is absent. */
async function fileLines(reader: GitObjectReader, tree: string, path: string): Promise<string[] | null> {
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
    return blob === null ? null : splitLines(await blob.text());
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
): Promise<{ base: string | null; files: PlanFileDiff[]; truncated: boolean } | undefined> {
  const head = await reader.readCommit(commit);
  if (head === null) return undefined;
  const from = baseSha ?? head.parents[0] ?? null;
  const base = from === null ? null : await reader.readCommit(from);
  if (from !== null && base === null) return undefined;
  // Only files inside the part's scopes are read: a blob outside them is never fetched.
  const files = (await changedFiles(reader, base?.treeHash ?? null, head.treeHash)).filter((file) => inside(file.path));
  const diffs = await fileDiffs(reader, files, (path) => scopeForPath(scopeMap, path) ?? null);
  return { base: from, files: diffs.files, truncated: diffs.truncated };
}

interface FactsBase {
  readonly change: PlanFacts["change"];
  readonly places: readonly AffectedPlace[];
  readonly breaks: readonly PlanBreakFact[];
  readonly invariants: readonly PlanInvariantFact[];
  readonly run: PlanFactsRun;
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
      detail: `${request.targets.length - 1} running features checked, ${affectedFeatures.length} affected`,
    },
    { fact: "invariants", tool: "penguin/invariants.json on main", detail: `${base.invariants.length} invariants of the affected scopes` },
    {
      fact: "breaks",
      tool: commands.length === 0 ? "no test command" : commands.join(", "),
      detail: report === null ? "waiting" : `${base.breaks.length} failing tests on ${request.targets.length} merged trees`,
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
