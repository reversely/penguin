// Which colleagues' features show as a banner on the signed-in person's pages (#125), and what a
// colleague's change page shows that person first. Pure, so the rules are tested without a browser
// (test/banner-view.test.ts). Every string is a bare label, a count or one clause with no comma.
//
// A banner comes from the person's own approvals inbox, which the shell already reads: a colleague's
// feature has a banner while the inbox holds an item of it for the person (a part to decide or one
// Penguin approved for them, a protected-path confirmation, an overlapping start), and its block has
// not reached main. Once the person approved their last part, confirmed their lines and approved the
// start, the inbox holds nothing of the feature and the banner clears.

import type { FeaturePage, OverlapRequest, PlanInbox, PlanPartView, TeamView } from "@penguin/protocol";

import { partAnchor, placeName } from "./pipeline-view.ts";

export interface Banner {
  readonly feature: string;
  /** The colleague whose feature it is. */
  readonly person: string;
  /** Whether a decision of the person's holds the feature up. */
  readonly needsYou: boolean;
  /** The change page, anchored at the first part the person decides when there is one. */
  readonly path: string;
}

/** A feature's change page, anchored at an element: `/features/money#part-3`. */
export function changePath(feature: string, anchor: string | null = null): string {
  return `/features/${encodeURIComponent(feature)}${anchor === null ? "" : `#${anchor}`}`;
}

/** The colleagues' features with something for `viewer` in their inbox, one banner each, those needing them first. */
export function colleagueBanners(inbox: { readonly overlaps: readonly OverlapRequest[]; readonly plan: PlanInbox }, team: TeamView | undefined, viewer: string): Banner[] {
  const promoted = new Set(team?.people.flatMap((person) => person.features.filter((feature) => feature.state === "promoted").map((feature) => feature.id)) ?? []);
  const banners = new Map<string, { person: string; needsYou: boolean; anchor: string | null }>();
  const add = (feature: string, person: string, needsYou: boolean, anchor: string | null) => {
    if (person === viewer || promoted.has(feature)) return;
    const found = banners.get(feature) ?? { person, needsYou: false, anchor: null };
    if (needsYou && !found.needsYou) found.anchor = anchor;
    found.needsYou ||= needsYou;
    found.anchor ??= anchor;
    banners.set(feature, found);
  };
  for (const part of inbox.plan.parts) {
    const decides = part.ask === "approve" && part.state === "pending";
    add(part.feature, part.person, decides || part.ask === "protected_path", partAnchor(part.partId));
  }
  for (const change of inbox.plan.protectedChanges) {
    if (change.state === "pending") add(change.feature, change.person, true, "changes");
  }
  for (const request of inbox.overlaps) add(request.blockedFeature, request.blockedPerson, true, null);
  return [...banners.entries()]
    .map(([feature, banner]) => ({ feature, person: banner.person, needsYou: banner.needsYou, path: changePath(feature, banner.anchor) }))
    .sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
}

/** One thing the viewer must do on a colleague's feature, with where they do it. */
export interface ToDo {
  readonly text: string;
  /** The element of the page it concerns, or null. */
  readonly anchor: string | null;
}

/** What `viewer` must do on a feature that is not theirs: decide their parts, confirm their lines, approve its start. */
export function viewerToDos(page: Pick<FeaturePage, "feature" | "plan" | "pipeline" | "waitingOn">, viewer: string): ToDo[] {
  if (page.feature.person === viewer) return [];
  const todos: ToDo[] = [];
  for (const part of page.plan?.parts ?? []) {
    if (part.owner === viewer && part.state === "pending") todos.push({ text: `Decide ${partNumberText(part)}`, anchor: partAnchor(part.partId) });
  }
  for (const stage of page.pipeline.stages) {
    for (const job of stage.jobs) {
      if (job.fact.kind === "protected" && job.fact.owner === viewer && job.fact.state === "pending") todos.push({ text: "Confirm your protected lines", anchor: null });
    }
  }
  for (const lock of page.waitingOn) if (lock.person === viewer && lock.state === "open") todos.push({ text: `Approve its start beside ${lock.feature}`, anchor: null });
  return todos;
}

function partNumberText(part: Pick<PlanPartView, "partId" | "place">): string {
  const hash = part.partId.lastIndexOf("#");
  return `${hash === -1 ? part.partId : part.partId.slice(hash)} ${placeName(part.place)}`;
}

/** One file of the viewer's parts, with the contract symbols its lines use. */
export interface YourFile {
  readonly anchor: string;
  readonly file: NonNullable<PlanPartView["files"]>[number];
  readonly symbols: readonly string[];
}

/** One of the viewer's parts within a scope, with its files. */
export interface YourPart {
  readonly part: PlanPartView;
  readonly files: readonly YourFile[];
}

/** The viewer's parts grouped by scope, then file, then symbol. */
export interface YourScope {
  readonly scope: string;
  readonly parts: readonly YourPart[];
}

/**
 * What changes for `viewer`: each part they own, grouped by its first scope, each file with the
 * changed contract symbols its callers use there. A part whose lines the server left out keeps its
 * state with no files.
 */
export function yourChanges(page: Pick<FeaturePage, "plan">, viewer: string): YourScope[] {
  const scopes = new Map<string, YourPart[]>();
  for (const part of page.plan?.parts ?? []) {
    if (part.owner !== viewer) continue;
    const scope = part.scopes[0] ?? placeName(part.place);
    const files = (part.files ?? []).map((file, index) => ({
      anchor: `${partAnchor(part.partId)}-file-${index + 1}`,
      file,
      symbols: [...new Set(part.callers.filter((use) => use.path === file.path).map((use) => use.symbol))],
    }));
    scopes.set(scope, [...(scopes.get(scope) ?? []), { part, files }]);
  }
  return [...scopes.entries()].map(([scope, parts]) => ({ scope, parts }));
}

/** The viewer's running features that read what the feature changes, each once with the scope it reads through. */
export function yourReaders(page: Pick<FeaturePage, "dependents">, viewer: string): FeaturePage["dependents"] {
  const seen = new Set<string>();
  return page.dependents.filter((dependent) => {
    const key = `${dependent.feature} ${dependent.consumerScope}`;
    if (dependent.person !== viewer || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
