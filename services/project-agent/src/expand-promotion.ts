// Promoting a feature's expand checkpoint on its own (PRD 0.5 section 4.2 step 2, 4.5 step 6). The
// expand step of a split adds the new shape beside the old one. It reaches main at once, from the
// feature's own fork, while the feature keeps building on top of it.
//
// 1. The feature's agent calls `land_feature` with `expand: true`. Penguin checks what a land checks
//    first: the latest checkpoint is in the fork and contains main's head, and every person whose
//    protected path the feature's own change touches confirmed its lines (protected-change.ts).
// 2. The Only adds check (section 5.1) reads the facts run of the checkpoint against main's head
//    (plan-facts.ts), the same impact run a merge plan reads, scheduling it when there is none. The
//    checkpoint passes when the impact report is complete, every entry of its contract diff is an
//    added symbol or a kept rename or move (the old name is an alias of the very same definition,
//    as Penguin's expand codemod writes it), no signature, export or stored data shape changes, and
//    the facts show no place: no caller on main or in a running feature's own changes, and no break.
//    A caller of a kept name still reaches the same definition, so it is no place. A refusal lists
//    every entry that fails.
//
//    A split feature (contract-split.ts) may name, in `retiring`, the replacement of each old name
//    the codemod does not expand; Penguin keeps them for the promotion, when the old names retire.
// 3. A checkpoint that adds to a scope another person owns waits on that person through the overlap
//    lock (overlap-lock.ts, an owner's-scope lock): the person is asked once per feature, on the
//    dashboard, and the agent lands again once they approve.
// 4. Penguin opens an `expand` block run through block-land.ts: the checkpoint merged onto main and
//    onto every other running feature's fork, the same checks, the same promotion slot and the same
//    push with Penguin's own short-lived token on main. The feature stays `building`, its fork keeps
//    its write tokens, and the promotion is a signed `expand_promotion` record.

import { ownerLockId, PLAN_MAIN_TARGET, placeLabel, type Author, type CharterView, type ImpactReport } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { ancestorsFound, blockTargets, mainState, protectedRefusal, targetFields, type LandDeps, type LandOutcome, type LandRejection, type LandRejectReason } from "./block-land.ts";
import { parseFeatureId, type Feature } from "./feature-store.ts";
import type { SqlDatabase } from "./issue-index.ts";
import { OVERLAP_LIMITS, type FeatureDependent, type OverlapListener, type OverlapStore } from "./overlap-lock.ts";
import { factsRequest, type PlanFactsStore } from "./plan-facts.ts";
import { affectedPlaces, breakFacts, type AffectedPlace } from "./propose-plan.ts";
import { splitReplacements, type ContractSplitStore } from "./contract-split.ts";

export interface ExpandDeps extends LandDeps {
  readonly db: SqlDatabase;
  /** The facts runs merge plans read: the impact run the Only adds check reuses. */
  readonly facts: PlanFactsStore;
  readonly scopeMap: () => Promise<ScopeMap>;
  /** The feature's dependents the overlap check stored, which the facts run tests. */
  readonly dependents: (featureId: string) => readonly FeatureDependent[];
  readonly overlaps: OverlapStore;
  readonly listener?: OverlapListener;
  /** The project's splits (contract-split.ts); absent, `retiring` is refused. */
  readonly splits?: ContractSplitStore;
}

export interface ExpandInput {
  readonly feature: unknown;
  /** The checkpoint the agent means to promote; when given, it must be the feature's latest. */
  readonly checkpoint?: unknown;
  /** For a split feature: the replacement of each old name the codemod does not expand. */
  readonly retiring?: unknown;
}

const SHA = /^[0-9a-f]{40}$/u;
const short = (sha: string): string => sha.slice(0, 12);
const rejected = (reason: LandRejectReason, message: string): LandRejection => ({ status: "rejected", reason, message });
const isRejection = (value: unknown): value is LandRejection =>
  typeof value === "object" && value !== null && (value as { status?: unknown }).status === "rejected";

/**
 * The entries that keep a checkpoint from only adding (PRD 5.1, Only adds), in report order: an
 * incomplete report, each changed symbol other than an added one, each changed signature, removed
 * export and changed stored data shape, then each place the change reaches. Empty when it only adds.
 */
export function onlyAddsFailures(impact: ImpactReport, places: readonly AffectedPlace[]): string[] {
  const failures: string[] = [];
  if (!impact.complete) {
    const unseen = impact.unanalysed.length === 0 ? "" : `: ${impact.unanalysed.join(", ")} could not be analysed`;
    failures.push(`the impact report is incomplete${impact.truncated ? " (a list was cut at its limit)" : ""}${unseen}`);
  }
  for (const change of impact.changes) {
    if (change.change !== "added" && change.kept !== true) failures.push(`${change.change} ${change.symbol} (${change.path}:${change.line})`);
  }
  for (const signature of impact.signatures) failures.push(`signature of ${signature.symbol} changed from ${signature.before} to ${signature.after}`);
  for (const removed of impact.removedExports) failures.push(`removed export ${removed.module}.${removed.name}`);
  for (const shape of impact.dataShapes) failures.push(`stored data shape of ${shape.symbol} changed (${shape.path}:${shape.line})`);
  for (const place of places) {
    failures.push(`${placeLabel(place.place)} is a place: ${place.callers.length} caller${place.callers.length === 1 ? "" : "s"}, ${place.breaks.length} break${place.breaks.length === 1 ? "" : "s"}`);
  }
  return failures;
}

/** The report without the uses of a kept rename or move: such a caller still reaches the same definition. */
function withoutKeptCallers(impact: ImpactReport): ImpactReport {
  const kept = new Set(impact.changes.filter((change) => change.kept === true).map((change) => change.symbol));
  if (kept.size === 0) return impact;
  const live = (use: { readonly symbol: string }) => !kept.has(use.symbol);
  return { ...impact, headUses: impact.headUses.filter(live), forks: impact.forks.map((fork) => ({ ...fork, uses: fork.uses.filter(live) })) };
}

interface PreparedExpand {
  readonly feature: Feature & { readonly repo: string; readonly latestCheckpointSha: string };
  readonly mainBefore: string;
  readonly factsRun: string;
  readonly added: readonly string[];
}

/** The scopes the checkpoint adds to that `personId` does not own, by owner, with their paths and contracts. */
function otherOwners(impact: ImpactReport, scopeMap: ScopeMap, personId: string): Map<string, { scopes: Set<string>; paths: Set<string>; contracts: Set<string> }> {
  const owners = new Map<string, { scopes: Set<string>; paths: Set<string>; contracts: Set<string> }>();
  for (const change of impact.changes) {
    const owner = change.scope === null ? undefined : scopeMap.scopes.get(change.scope)?.ownerId;
    if (owner === undefined || owner === personId) continue;
    const entry = owners.get(owner) ?? { scopes: new Set<string>(), paths: new Set<string>(), contracts: new Set<string>() };
    entry.scopes.add(change.scope as string);
    entry.paths.add(change.path);
    if (change.contract !== null) entry.contracts.add(change.contract);
    owners.set(owner, entry);
  }
  return owners;
}

/**
 * Asks each other owner whose scope the checkpoint adds to, once per feature: an owner's-scope lock is
 * opened for each owner without one, with a signed `overlap_check` record. Returns the owners whose
 * lock is still open.
 */
async function waitOnOwners(deps: ExpandDeps, feature: Feature, impact: ImpactReport, scopeMap: ScopeMap): Promise<string[]> {
  const held = new Map(deps.overlaps.ownerLocksOn(feature.id).map((lock) => [lock.personId, lock]));
  const opened: { person: string; overlap: { scopes: string[]; paths: string[]; contracts: string[]; omittedPaths: number } }[] = [];
  const waiting: string[] = [];
  for (const [person, touched] of [...otherOwners(impact, scopeMap, feature.personId)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const lock = held.get(person);
    if (lock?.state === "approved") continue;
    waiting.push(person);
    if (lock !== undefined) continue;
    const paths = [...touched.paths].sort();
    opened.push({
      person,
      overlap: { scopes: [...touched.scopes].sort(), paths: paths.slice(0, OVERLAP_LIMITS.paths), contracts: [...touched.contracts].sort(), omittedPaths: Math.max(0, paths.length - OVERLAP_LIMITS.paths) },
    });
  }
  if (opened.length === 0) return waiting;
  const record = await deps.sign(
    deps.features.draftRecord(feature.id, "overlap_check", { penguin: true }, {
      expand: feature.latestCheckpointSha,
      locks_opened: opened.map(({ person, overlap }) => ({ owner: person, overlap })),
    }),
  );
  const fresh = deps.db.transaction(() => {
    const made = opened.filter(({ person, overlap }) => deps.overlaps.openOwnerLock(person, feature.id, overlap));
    deps.features.addRecord(record);
    return made;
  });
  for (const { person } of fresh) deps.listener?.lockOpened({ featureId: ownerLockId(person), blockedFeatureId: feature.id, personId: person });
  return waiting;
}

/** The facts an expand needs, or why the checkpoint may not be promoted on its own yet. */
async function prepareExpand(deps: ExpandDeps, feature: Feature, checkpoint: unknown): Promise<PreparedExpand | LandRejection> {
  if (feature.state === "landed") return rejected("conflict", `feature ${feature.id} has landed; its fork is read-only`);
  if (feature.state === "landing") return rejected("busy", `feature ${feature.id} is landing; an expand waits until it builds again`);
  if (feature.repo === null) return rejected("not_found", `feature ${feature.id} has no fork yet`);
  const latest = feature.latestCheckpointSha;
  if (latest === null) return rejected("not_ready", `feature ${feature.id} has no checkpoint; report one with report_checkpoint first`);
  if (checkpoint !== undefined && checkpoint !== latest) {
    return rejected("conflict", `the feature's latest checkpoint is ${latest}; report the commit you mean to promote as a checkpoint first`);
  }
  const main = await mainState(deps);
  if (main.head === null) return rejected("not_found", `main's ${deps.branch} branch has no commit`);
  if (main.head === latest) return rejected("not_ready", `main is already at ${short(latest)}; nothing to promote`);
  const inFork = await deps.readRepo(feature.repo, (reader) => ancestorsFound(reader, latest, new Set([main.head as string]), main.history));
  if (!inFork.has(main.head)) {
    return rejected("behind_main", `main moved to ${main.head} since checkpoint ${short(latest)} was built; merge main into your fork, report the merge as a checkpoint and promote again`);
  }

  // A change to a path another person protects waits on that person's confirmation, as a land does.
  const unconfirmed = protectedRefusal(deps, feature.id);
  if (unconfirmed !== undefined) return unconfirmed;

  // The Only adds check reads the impact run of the checkpoint against main's head.
  const scopeMap = await deps.scopeMap();
  const known = deps.facts.forCheckpoint(feature.id, latest);
  const run =
    known !== undefined && known.request.baseline === main.head
      ? known
      : deps.facts.schedule(factsRequest(feature, main.head, scopeMap, deps.features.list(), deps.dependents(feature.id)));
  if (run.state !== "reported" || run.report === null) {
    return rejected("waiting_for_runner", `the check runner has not reported facts run ${run.runId}, the impact run of ${short(latest)} against main; promote again once it has`);
  }
  const impact = run.report.impact;
  if (impact === null) return rejected("impact_failed", `the impact analysis of facts run ${run.runId} failed on the check runner, so the Only adds check cannot run`);
  const heads = new Map(run.request.targets.filter((target) => target.id !== PLAN_MAIN_TARGET).map((target) => [target.id, target.sha]));
  const places = affectedPlaces(withoutKeptCallers(impact), breakFacts(run.report), scopeMap, deps.features, heads);
  const failures = onlyAddsFailures(impact, places);
  if (failures.length > 0) {
    return rejected("not_only_adds", `checkpoint ${short(latest)} does not only add, so it cannot reach main on its own: ${failures.join("; ")}`);
  }
  const waiting = await waitOnOwners(deps, feature, impact, scopeMap);
  if (waiting.length > 0) {
    return rejected(
      "waiting_on_owner",
      `checkpoint ${short(latest)} adds to scopes ${waiting.join(", ")} own${waiting.length === 1 ? "s" : ""}; Penguin asked each once on the dashboard. Promote again once they approve`,
    );
  }
  return { feature: feature as PreparedExpand["feature"], mainBefore: main.head, factsRun: run.runId, added: impact.changes.map((change) => change.symbol) };
}

/** Opens the expand run of a prepared checkpoint and records the request; the feature stays `building`. */
async function openExpand(deps: ExpandDeps, prepared: PreparedExpand, charter: CharterView, author: Author, requestedBy: string): Promise<LandOutcome> {
  const { feature, mainBefore } = prepared;
  const targets = await blockTargets(deps, feature.id);
  const opened = await deps.agent(feature.id).openBlockRun({
    featureId: feature.id,
    planId: null,
    purpose: "expand",
    fork: `feature-${feature.id}`,
    checkpoint: feature.latestCheckpointSha,
    mainBefore,
    branch: deps.branch,
    targets,
    charter,
    requestedBy,
  });
  if (opened.status === "busy") return rejected("busy", `feature ${feature.id} is already landing or promoting (run ${opened.run.runId}, ${opened.run.state})`);
  const record = await deps.sign(
    deps.features.draftRecord(feature.id, "expand_requested", author, {
      run_id: opened.run.runId,
      checkpoint: feature.latestCheckpointSha,
      main_before: mainBefore,
      branch: deps.branch,
      targets: targetFields(targets),
      facts_run: prepared.factsRun,
      added: [...prepared.added],
      superseded: [...opened.superseded],
    }),
  );
  deps.features.addRecord(record);
  deps.queue.add(feature.id);
  deps.notify(feature.personId);
  return { status: "checking", run: opened.run, recordId: record.record_id };
}

/**
 * `land_feature` with `expand: true`: `caller`'s session asks Penguin to promote its feature's latest
 * checkpoint on its own. Refused unless it is ready and only adds (see the module comment).
 */
export async function requestExpand(deps: ExpandDeps, caller: string, sessionId: string, input: ExpandInput): Promise<LandOutcome> {
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
    return rejected("forbidden", `only an agent session of feature ${id} promotes its checkpoints`);
  }
  const charter = deps.charter(live.session.handle, feature.personId);
  if (charter === undefined) return rejected("not_found", `identity ${live.session.handle} has no charter`);
  const replacements = input.retiring === undefined ? [] : splitReplacements(deps.splits?.get(id), input.retiring);
  if (typeof replacements === "string") return rejected("invalid", replacements);
  const prepared = await prepareExpand(deps, feature, input.checkpoint);
  if (isRejection(prepared)) return prepared;
  if (replacements.length > 0) deps.splits?.name(id, replacements);
  return openExpand(deps, prepared, charter, { identity: live.session.handle }, live.session.handle);
}

/**
 * Penguin promotes the expand again after main refused its push (a race): the same checks on main's
 * new head. When the checkpoint may no longer be promoted as it is, a signed `land_returned` record
 * says why; the feature was building throughout.
 */
export async function retryExpand(deps: ExpandDeps, featureId: string, previous: { readonly runId: string; readonly charter: CharterView }): Promise<LandOutcome> {
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature has id ${featureId}`);
  const prepared = await prepareExpand(deps, feature, undefined);
  if (!isRejection(prepared)) return openExpand(deps, prepared, previous.charter, { penguin: true }, "penguin");
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "land_returned", { penguin: true }, { run_id: previous.runId, purpose: "expand", reason: prepared.reason, message: prepared.message }),
  );
  deps.features.addRecord(record);
  deps.notify(feature.personId);
  return prepared;
}
