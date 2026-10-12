// What the org, team and person pages derive from GET /api/team (#136), following the hierarchy of
// PRD 0.5: org, team, person, feature, part, file. Pure, so the rules are tested without a browser
// (test/hierarchy-view.test.ts).
//
// Scale: a page shows counts, the top few items as pills and tables; a list of every feature or every
// waiting item belongs to the level below.

import type { DashboardAgent, EditTaskCounts, FeaturePlanView, PipelineStageKey, TeamFeature, TeamPerson, TeamScopeSummary, TeamSummary, TeamView, WaitingItem, WaitingKind } from "@penguin/protocol";

import { partNumber } from "./feature-view.ts";
import { partAnchor, placeName, STAGE_LABEL } from "./pipeline-view.ts";

/** The teams a person leads or belongs to: declared teams first, each in the view's order. */
export function personTeams(teams: readonly TeamSummary[], person: string): TeamSummary[] {
  const theirs = teams.filter((team) => team.lead === person || team.members.includes(person));
  return [...theirs.filter((team) => !team.implicit), ...theirs.filter((team) => team.implicit)];
}

/**
 * The team a person's pages sit under, and the viewer's home page: the first declared team they lead,
 * else the first they belong to, else their one-person team.
 */
export function homeTeam(teams: readonly TeamSummary[], person: string): TeamSummary | undefined {
  const theirs = personTeams(teams, person);
  return theirs.find((team) => !team.implicit && team.lead === person) ?? theirs[0];
}

/** A team's name as its pages show it: a one-person team takes its person's id. */
export function teamName(team: TeamSummary): string {
  return team.implicit ? team.lead : team.name;
}

/** A team's people: the lead first, then the members in the order the team file lists them. */
export function teamMembers(team: TeamSummary): string[] {
  return [...new Set([team.lead, ...team.members])];
}

/**
 * Where a feature stands for a person reading the page: needing a person, in progress, on main, or
 * closed (a block Penguin closed with nothing left to carry). The last two have settled.
 */
export type FeatureGroup = "person" | "running" | "main" | "closed";

export const GROUP_LABEL: Readonly<Record<FeatureGroup, string>> = {
  person: "Needs a person",
  running: "In progress",
  main: "On main",
  closed: "Closed",
};

/** The groups whose features have settled, which the pages fold and list no agents for. */
export const SETTLED: readonly FeatureGroup[] = ["main", "closed"];

/** A feature's group: settled once its block reached main or closed, needing a person when its current stage or an exception does. */
export function featureGroup(feature: Pick<TeamFeature, "state" | "strip" | "exceptions">): FeatureGroup {
  if (feature.state === "promoted") return "main";
  if (feature.state === "closed") return "closed";
  const status = feature.strip.stages[feature.strip.current]?.status;
  return status === "person" || status === "failed" || feature.exceptions.length > 0 ? "person" : "running";
}

/** A person's features by group, each group in the view's order (newest first). */
export function groupFeatures(features: readonly TeamFeature[]): Record<FeatureGroup, TeamFeature[]> {
  const groups: Record<FeatureGroup, TeamFeature[]> = { person: [], running: [], main: [], closed: [] };
  for (const feature of features) groups[featureGroup(feature)].push(feature);
  return groups;
}

/** Features at one stage: the stage's name, how many, whether any needs a person, and the builders' open tasks. */
export interface StageBucket {
  readonly key: string;
  readonly label: string;
  readonly features: readonly string[];
  readonly attention: boolean;
  readonly tasks: EditTaskCounts;
}

const STAGE_ORDER: readonly PipelineStageKey[] = ["open", "plan", "expand", "review", "migrate", "fixes", "contract", "checks", "done", "promoted"];
const NO_TASKS: EditTaskCounts = { running: 0, queued: 0, asked: 0 };
const addTasks = (a: EditTaskCounts, b: EditTaskCounts | undefined): EditTaskCounts =>
  b === undefined ? a : { running: a.running + b.running, queued: a.queued + b.queued, asked: a.asked + b.asked };

/**
 * Features counted by their current stage, as stage pills with counts: the stages needing a person
 * first, then in pipeline order, then the features on main as one bucket. A stage needing a person and
 * the same stage running are separate buckets, so the attention pill counts only what needs a person.
 */
export function stageBuckets(features: readonly TeamFeature[]): StageBucket[] {
  const buckets = new Map<string, { key: string; label: string; features: string[]; attention: boolean; tasks: EditTaskCounts; order: number }>();
  for (const feature of features) {
    const group = featureGroup(feature);
    const stage = feature.strip.stages[feature.strip.current]?.key ?? "open";
    const settled = SETTLED.indexOf(group);
    const key = settled === -1 ? `${stage}:${group}` : group;
    // A feature at its last stage has not reached main yet: its pill names the step it waits for, so
    // it does not read as promoted beside On main.
    const label = settled !== -1 ? GROUP_LABEL[group] : stage === "promoted" || stage === "done" ? "Promotion" : STAGE_LABEL[stage];
    const order = settled !== -1 ? 2 * STAGE_ORDER.length + settled : (group === "person" ? 0 : STAGE_ORDER.length) + STAGE_ORDER.indexOf(stage);
    const bucket = buckets.get(key) ?? { key, label, features: [], attention: group === "person", tasks: NO_TASKS, order };
    bucket.features.push(feature.id);
    bucket.tasks = addTasks(bucket.tasks, feature.builderTasks);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...bucket }) => bucket);
}

/** The builders' open tasks as one short count, `2 tasks` or `1 task asked`; null for none. */
export function taskText(tasks: EditTaskCounts): string | null {
  const open = tasks.running + tasks.queued + tasks.asked;
  if (open === 0) return null;
  const noun = open === 1 ? "task" : "tasks";
  return tasks.asked > 0 ? `${open} ${noun} ${tasks.asked} asked` : `${open} ${noun}`;
}

/** Everything that waits on a person. */
export function waitingTotal(person: Pick<TeamPerson, "waiting">): number {
  return (person.waiting ?? []).reduce((sum, item) => sum + item.count, 0);
}

const KIND_NOUN: Readonly<Record<WaitingKind, readonly [string, string]>> = {
  part: ["part", "parts"],
  start: ["start", "starts"],
  confirmation: ["confirmation", "confirmations"],
  task: ["task", "tasks"],
};

/** One waiting item as a count with its noun: `3 parts`. */
export function waitingText(item: Pick<WaitingItem, "kind" | "count">): string {
  const [one, many] = KIND_NOUN[item.kind];
  return `${item.count} ${item.count === 1 ? one : many}`;
}

/** A person's waiting items by feature, most first: each feature once with its kinds. */
export function waitingByFeature(items: readonly WaitingItem[]): { readonly feature: string; readonly count: number; readonly items: readonly WaitingItem[] }[] {
  const byFeature = new Map<string, WaitingItem[]>();
  for (const item of items) byFeature.set(item.feature, [...(byFeature.get(item.feature) ?? []), item]);
  return [...byFeature.entries()]
    .map(([feature, held]) => ({ feature, count: held.reduce((sum, item) => sum + item.count, 0), items: held }))
    .sort((a, b) => b.count - a.count || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
}

/**
 * A person's agents as the pages list them. Builders are the agents on the person's features that have
 * not reached main. Agents on no feature are the idle ones left after the steward, which has its own
 * place, and the builders of features on main, which have finished: that leaves idle stewards and the
 * builders of paused features.
 */
export function personAgents(person: Pick<TeamPerson, "features" | "idleAgents" | "steward">): { readonly builders: readonly DashboardAgent[]; readonly idle: readonly DashboardAgent[] } {
  const steward = person.steward?.handle;
  const builders = new Map<string, DashboardAgent>();
  const finished = new Set<string>();
  for (const feature of person.features) {
    for (const agent of feature.agents) {
      if (agent.handle === steward) continue;
      if (feature.state === "promoted" || feature.state === "closed") finished.add(agent.handle);
      else builders.set(agent.handle, agent);
    }
  }
  const idle = person.idleAgents.filter((agent) => agent.handle !== steward && !builders.has(agent.handle) && !finished.has(agent.handle));
  return { builders: [...builders.values()], idle };
}

/** A scope's health as tags: what waits in it and its declared dependencies the code no longer shows, else Clean. */
export function healthTags(scope: Pick<TeamScopeSummary, "health">): { readonly text: string; readonly attention: boolean }[] {
  const health = scope.health;
  if (health === undefined) return [];
  const tags: { text: string; attention: boolean }[] = [];
  if (health.waiting > 0) tags.push({ text: `${health.waiting} waiting`, attention: true });
  if (health.notInCode > 0) tags.push({ text: `${health.notInCode} not in code`, attention: true });
  return tags.length === 0 ? [{ text: "Clean", attention: false }] : tags;
}

/** Whether nothing stands open against a scope. */
export function scopeClean(scope: Pick<TeamScopeSummary, "health">): boolean {
  return scope.health !== undefined && scope.health.waiting === 0 && scope.health.notInCode === 0;
}

/** One team's row on the org page. */
export interface OrgRow {
  readonly team: TeamSummary;
  readonly people: number;
  readonly stages: readonly StageBucket[];
  readonly waiting: number;
  readonly scopes: number;
  readonly clean: number;
}

/**
 * Each team's row on the org page: its people, its members' features by stage, what waits on its
 * members and how many of its scopes are clean. Declared teams come first; a person in two teams
 * counts in each.
 */
export function orgRows(view: TeamView): OrgRow[] {
  const people = new Map(view.people.map((person) => [person.id, person]));
  const teams = view.teams ?? [];
  return [...teams.filter((team) => !team.implicit), ...teams.filter((team) => team.implicit)].map((team) => {
    const members = teamMembers(team).flatMap((id) => people.get(id) ?? []);
    return {
      team,
      people: members.length,
      stages: stageBuckets(members.flatMap((person) => person.features)),
      waiting: members.reduce((sum, person) => sum + waitingTotal(person), 0),
      scopes: team.scopes.length,
      clean: team.scopes.filter(scopeClean).length,
    };
  });
}

/** Scopes needing attention first, then by name. */
export function orderScopes(scopes: readonly TeamScopeSummary[]): TeamScopeSummary[] {
  return [...scopes].sort((a, b) => Number(scopeClean(a)) - Number(scopeClean(b)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The crumbs under a feature for the part and the file a feature page's anchor opened: `part-3` gives
 * the part's number and place, such as `#3 tax`; `part-3-file-1` adds the file's name. Each carries
 * the anchor it opens. None for any other anchor or a part the plan does not hold.
 */
export function partCrumbs(plan: Pick<FeaturePlanView, "parts"> | null, anchor: string): { readonly label: string; readonly anchor: string }[] {
  const match = /^part-(\d+)(?:-file-(\d+))?$/u.exec(anchor);
  if (match === null || plan === null) return [];
  const partId = `part-${match[1]}`;
  const part = plan.parts.find((each) => partAnchor(each.partId) === partId);
  if (part === undefined) return [];
  const crumbs = [{ label: `${partNumber(part.partId)} ${placeName(part.place)}`, anchor: partId }];
  const file = match[2] === undefined ? undefined : part.files?.[Number(match[2]) - 1];
  if (file !== undefined) crumbs.push({ label: file.path.split("/").at(-1) ?? file.path, anchor });
  return crumbs;
}
