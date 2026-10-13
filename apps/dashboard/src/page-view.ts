// What the feature page derives from its answer: the three summary lines at its top, the view (tab)
// and the folds a link opens, which folds open on their own for a viewer, and the rows of the Read by
// and Start tables. Pure, so the rules are tested without a browser (test/pipeline-view.test.ts). Every
// string is a bare label, a count or one clause with no comma.

import type { DecisionRoute, FeaturePage, JobStatus, PipelineStageKey, PipelineStrip, PlanPartState } from "@penguin/protocol";

import { counted } from "./feature-view.ts";
import { jobText, partAnchor } from "./pipeline-view.ts";

export const CONTRACT_FOLD = "change-contract";

/** The page's four views, each with its own anchor. */
export const VIEWS = ["changes", "pipeline", "people", "record"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Readonly<Record<View, string>> = { changes: "Changes", pipeline: "Pipeline", people: "People", record: "Record" };

/** The element id of a stage's fold in the Pipeline view. */
export function stageAnchor(stage: PipelineStageKey): string {
  return `stage-${stage}`;
}

/** The view that holds an element of the page, by the element's id. */
export function viewOf(id: string): View | undefined {
  if ((VIEWS as readonly string[]).includes(id)) return id as View;
  if (id.startsWith("part-") || id.startsWith("change-") || id === "area") return "changes";
  if (id.startsWith("stage-") || id.startsWith("review-") || id === "checks" || id === "reviews") return "pipeline";
  if (id === "read-by" || id === "start" || id === "agents") return "people";
  return undefined;
}

/** The folds that hold a fold, outermost first, so a link opens every one on its way. */
export function foldParents(id: string): string[] {
  const part = /^(part-\d+)-/.exec(id)?.[1];
  if (part !== undefined) return [part];
  if (id.startsWith("review-")) return [stageAnchor("review"), "reviews"];
  if (id === "reviews") return [stageAnchor("review")];
  if (id === "checks") return [stageAnchor("checks")];
  if (id === "change-callers") return [CONTRACT_FOLD];
  return [];
}

export interface SummaryLine {
  readonly label: string;
  readonly fact: string | null;
  /** The id of the view or fold the line opens. */
  readonly target: string;
  readonly tone?: "attention" | "failure";
}

/** The other features and people the feature reaches: its readers, its parts' owners and its locks. */
export function reach(page: Pick<FeaturePage, "feature" | "plan" | "dependents" | "waitingOn">): { readonly features: number; readonly people: number } {
  const features = new Set<string>();
  const people = new Set<string>();
  for (const dependent of page.dependents) {
    features.add(dependent.feature);
    people.add(dependent.person);
  }
  for (const part of page.plan?.parts ?? []) {
    if (part.place.kind === "feature") features.add(part.place.feature);
    people.add(part.owner);
  }
  for (const lock of page.waitingOn) {
    features.add(lock.feature);
    people.add(lock.person);
  }
  people.delete(page.feature.person);
  return { features: features.size, people: people.size };
}

/** What needs a person on the feature, the most pressing first: a part, a failed check or a returned plan. */
function needing(page: Pick<FeaturePage, "pipeline">): SummaryLine | null {
  const jobs = page.pipeline.stages.flatMap((stage) => stage.jobs.map((job) => ({ stage: stage.key, job })));
  for (const { job } of jobs) {
    if (job.fact.kind === "part" && (job.status === "person" || job.status === "failed")) {
      const text = jobText(job.fact);
      return { label: text.label, fact: text.fact, target: partAnchor(job.fact.partId), tone: "attention" };
    }
  }
  for (const { stage, job } of jobs) {
    if (job.status !== "failed" && job.status !== "person") continue;
    const text = jobText(job.fact);
    return { label: text.label, fact: text.fact, target: stageAnchor(stage), tone: job.status === "failed" ? "failure" : "attention" };
  }
  return null;
}

/**
 * The summary, at most three lines: the main change, how many features and people the feature
 * reaches, and the first thing that needs a person. `first` replaces the third line with what the
 * viewer must do on a colleague's feature.
 */
export function summaryLines(page: Pick<FeaturePage, "feature" | "plan" | "contract" | "pipeline" | "dependents" | "waitingOn">, first: SummaryLine | null = null): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const diff = page.plan?.contractDiff ?? null;
  const entries = page.contract?.entries.length ?? 0;
  if (diff !== null || entries > 0) {
    const breaking = diff?.signatures.filter((signature) => signature.breaking).length ?? 0;
    const incompatible = page.contract?.counts?.incompatible ?? 0;
    const facts = [counted(diff?.changes.length ?? entries, "change")];
    if (breaking > 0) facts.push(`${breaking} breaking`);
    if (incompatible > 0) facts.push(`${incompatible} incompatible`);
    lines.push({ label: "Contract", fact: facts.join(" "), target: CONTRACT_FOLD });
  }
  const reached = reach(page);
  if (reached.features + reached.people > 0) lines.push({ label: counted(reached.features, "feature"), fact: counted(reached.people, "person", "people"), target: "people" });
  const third = first ?? needing(page);
  if (third !== null) lines.push(third);
  return lines;
}

/** The folds that open on their own: the parts the viewer decides that wait on them, with their files. */
export function initialFolds(page: Pick<FeaturePage, "plan">, viewer: string): string[] {
  const open: string[] = [];
  for (const part of page.plan?.parts ?? []) {
    if (part.owner !== viewer || part.state !== "pending") continue;
    const anchor = partAnchor(part.partId);
    open.push(anchor);
    // A short fix opens its files too; a long one leaves them to the reader.
    if (part.files !== null && part.files.length <= 2) part.files.forEach((_, index) => open.push(`${anchor}-file-${index + 1}`));
  }
  return open;
}

/** The pill tone of a status, one fixed colour each. */
export type Tone = "waiting" | "running" | "passed" | "failed" | "person";

/** One running feature that reads what this feature changes. */
export interface ReadByRow {
  readonly feature: string;
  readonly person: string;
  /** The reading scope and the scope it reads, each with its owner for the pill's colour. */
  readonly reads: { readonly scope: string; readonly owner: string | null };
  readonly from: { readonly scope: string; readonly owner: string | null };
  /** The reading feature's own current stage, from the team view; null while unknown. */
  readonly stage: { readonly key: PipelineStageKey; readonly status: JobStatus } | null;
  /** This plan's part for the reading feature, with its state; null when the plan has none. */
  readonly part: { readonly partId: string; readonly state: PlanPartState } | null;
}

const PRESSING: Readonly<Record<JobStatus, number>> = { person: 0, failed: 1, running: 2, waiting: 3, passed: 4 };

/**
 * The Read by table: one row per running feature and reading scope, needing a person first, then by
 * the stage each reader stands at. `strips` and `owners` come from the team view.
 */
export function readByRows(
  page: Pick<FeaturePage, "dependents" | "plan">,
  strips: ReadonlyMap<string, PipelineStrip>,
  owners: ReadonlyMap<string, string>,
): ReadByRow[] {
  const seen = new Set<string>();
  const rows: ReadByRow[] = [];
  for (const dependent of page.dependents) {
    const key = `${dependent.feature} ${dependent.consumerScope} ${dependent.providerScope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const strip = strips.get(dependent.feature);
    const current = strip?.stages[strip.current];
    const part = page.plan?.parts.find((each) => each.place.kind === "feature" && each.place.feature === dependent.feature);
    rows.push({
      feature: dependent.feature,
      person: dependent.person,
      reads: { scope: dependent.consumerScope, owner: owners.get(dependent.consumerScope) ?? null },
      from: { scope: dependent.providerScope, owner: owners.get(dependent.providerScope) ?? null },
      stage: current === undefined ? null : { key: current.key, status: current.status },
      part: part === undefined ? null : { partId: part.partId, state: part.state },
    });
  }
  const rank = (row: ReadByRow) => (row.part?.state === "pending" || row.part?.state === "round_limit" ? -1 : PRESSING[row.stage?.status ?? "waiting"]);
  const index = (row: ReadByRow) => (row.stage === null ? 99 : (strips.get(row.feature)?.current ?? 99));
  return rows.sort((a, b) => rank(a) - rank(b) || index(a) - index(b) || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
}

/** The record's kinds with their counts, in the order each kind first appears. */
export function recordKinds(records: FeaturePage["records"]): { readonly type: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
}

/** A copy write into a part's fork: who wrote it and the originating revision it copied the modules from. */
export interface CopyWrite {
  readonly route: DecisionRoute;
  readonly from: string;
}

/**
 * Each part's own fix write route, from the newest `fix_write` record naming the part that is not a
 * copy write, and each part's copy writes in record order. A behavioural part's agent writes its patch,
 * then Penguin's check runner copies the originating modules into the same fork under the same part id.
 */
export function partWrites(records: FeaturePage["records"]): { readonly writes: Map<string, DecisionRoute>; readonly copies: Map<string, CopyWrite[]> } {
  const writes = new Map<string, DecisionRoute>();
  const copies = new Map<string, CopyWrite[]>();
  for (const record of records) {
    if (record.type !== "fix_write" || !record.partId || !record.route) continue;
    if (record.copiedFrom === undefined) writes.set(record.partId, record.route);
    else copies.set(record.partId, [...(copies.get(record.partId) ?? []), { route: record.route, from: record.copiedFrom }]);
  }
  return { writes, copies };
}
