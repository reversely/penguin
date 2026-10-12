// The org, team and person pages (#136): the viewer's home team, features counted by stage, what waits
// on a person, which agents each page lists and each scope's health.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DashboardAgent, PipelineStrip, TeamFeature, TeamPerson, TeamSummary, TeamView } from "@penguin/protocol";

import {
  featureGroup,
  groupFeatures,
  healthTags,
  homeTeam,
  orderScopes,
  orgRows,
  partCrumbs,
  personAgents,
  stageBuckets,
  taskText,
  teamMembers,
  waitingByFeature,
  waitingText,
  waitingTotal,
} from "../src/hierarchy-view.ts";
import { load } from "./render.ts";

const team = (id: string, lead: string, members: string[], fields: Partial<TeamSummary> = {}): TeamSummary => ({ id, name: id[0]?.toUpperCase() + id.slice(1), lead, members, implicit: false, scopes: [], ...fields });

const strip = (path: "plan" | "split", current: number, status: "waiting" | "running" | "person" | "failed" | "passed"): PipelineStrip => {
  const keys = path === "plan" ? (["open", "plan", "review", "fixes", "checks", "promoted"] as const) : (["open", "expand", "migrate", "contract", "done"] as const);
  return { path, current, stages: keys.map((key, index) => ({ key, status: index < current ? "passed" : index === current ? status : "waiting", passed: 0, jobs: 0 })) };
};

const agent = (handle: string): DashboardAgent => ({ handle, identityId: handle, person: "ines", online: true });

function feature(id: string, fields: Partial<TeamFeature> = {}): TeamFeature {
  return { id, person: "ines", state: "building", strip: strip("plan", 2, "running"), exceptions: [], agents: [], openedAt: "2026-10-11T09:00:00.000Z", ...fields };
}

test("the viewer's home is the first declared team they lead, else one they belong to, else their own one-person team", () => {
  const teams = [team("payments", "ines", ["ines", "kofi"]), team("shopping", "tomas", ["tomas", "ines"]), team("person:sam", "sam", ["sam"], { implicit: true })];
  assert.equal(homeTeam(teams, "ines")?.id, "payments");
  assert.equal(homeTeam(teams, "kofi")?.id, "payments");
  assert.equal(homeTeam([teams[1] as TeamSummary, teams[0] as TeamSummary], "ines")?.id, "payments", "a team they lead comes before one they belong to");
  assert.equal(homeTeam(teams, "sam")?.id, "person:sam");
  assert.equal(homeTeam(teams, "nobody"), undefined);
  // The lead comes first and shows once, though the team file lists them as a member too.
  assert.deepEqual(teamMembers(teams[1] as TeamSummary), ["tomas", "ines"]);
});

test("features count by their current stage: what needs a person first, then in pipeline order, then those on main", () => {
  const features = [
    feature("a", { state: "promoted", strip: strip("plan", 5, "passed") }),
    feature("b", { strip: strip("plan", 2, "person"), builderTasks: { running: 1, queued: 0, asked: 1 } }),
    feature("c", { strip: strip("plan", 1, "running"), builderTasks: { running: 0, queued: 2, asked: 0 } }),
    feature("d", { strip: strip("split", 1, "running") }),
    feature("e", { state: "promoted", strip: strip("split", 4, "passed") }),
    feature("f", { strip: strip("plan", 2, "running"), exceptions: [{ kind: "round_limit", partId: "p#1" }] }),
    feature("g", { strip: strip("plan", 2, "running") }),
    // Every stage passed but main has not moved: the pill names the promotion it waits for.
    feature("h", { state: "planning", strip: strip("plan", 5, "waiting") }),
    // A block Penguin closed with nothing left to carry has settled apart from main.
    feature("i", { state: "closed", strip: strip("split", 2, "passed") }),
  ];
  assert.deepEqual(
    stageBuckets(features).map((bucket) => [bucket.label, bucket.features.length, bucket.attention, taskText(bucket.tasks)]),
    [
      ["Review", 2, true, "2 tasks 1 asked"],
      ["Plan", 1, false, "2 tasks"],
      ["Expand", 1, false, null],
      ["Review", 1, false, null],
      ["Promotion", 1, false, null],
      ["On main", 2, false, null],
      ["Closed", 1, false, null],
    ],
  );
  assert.deepEqual(
    Object.entries(groupFeatures(features)).map(([group, held]) => [group, held.map((each) => each.id)]),
    [
      ["person", ["b", "f"]],
      ["running", ["c", "d", "g", "h"]],
      ["main", ["a", "e"]],
      ["closed", ["i"]],
    ],
  );
  assert.equal(featureGroup(feature("x", { strip: strip("plan", 4, "failed") })), "person");
  assert.equal(taskText({ running: 1, queued: 0, asked: 0 }), "1 task");
  assert.equal(taskText({ running: 0, queued: 0, asked: 0 }), null);
});

test("what waits on a person totals every kind and groups by feature, most first", () => {
  const person: Pick<TeamPerson, "waiting"> = {
    waiting: [
      { feature: "money", kind: "part", count: 3 },
      { feature: "tax", kind: "start", count: 1 },
      { feature: "money", kind: "task", count: 1 },
      { feature: "audit", kind: "confirmation", count: 2 },
    ],
  };
  assert.equal(waitingTotal(person), 7);
  assert.equal(waitingTotal({}), 0, "an older Worker sends no waiting");
  assert.deepEqual(
    waitingByFeature(person.waiting ?? []).map((each) => [each.feature, each.count, each.items.map(waitingText)]),
    [
      ["money", 4, ["3 parts", "1 task"]],
      ["audit", 2, ["2 confirmations"]],
      ["tax", 1, ["1 start"]],
    ],
  );
});

test("builders of features on main leave the agent lists; agents on no feature are idle stewards and builders of paused features", () => {
  const person: Pick<TeamPerson, "features" | "idleAgents" | "steward"> = {
    steward: { handle: "@ines/steward", identityId: "s", online: true, running: 0, queued: 0, asked: 0, cap: 2 },
    features: [
      feature("money", { agents: [agent("@ines/money"), agent("@ines/steward")] }),
      feature("tax", { state: "promoted", agents: [agent("@ines/tax")] }),
    ],
    idleAgents: [agent("@ines/steward"), agent("@ines/tax"), agent("@ines/paused"), agent("@ines/other-steward")],
  };
  const { builders, idle } = personAgents(person);
  assert.deepEqual(
    builders.map((each) => each.handle),
    ["@ines/money"],
  );
  assert.deepEqual(
    idle.map((each) => each.handle),
    ["@ines/paused", "@ines/other-steward"],
  );
});

test("a scope's health names what waits in it and its declared dependencies the code no longer shows; the rest are clean", () => {
  const scope = (id: string, waiting: number, notInCode: number) => ({ id, name: id, dri: "ines", fallback: [], reads: 1, readBy: 2, health: { waiting, notInCode } });
  assert.deepEqual(healthTags(scope("a", 0, 0)), [{ text: "Clean", attention: false }]);
  assert.deepEqual(healthTags(scope("b", 2, 1)), [
    { text: "2 waiting", attention: true },
    { text: "1 not in code", attention: true },
  ]);
  assert.deepEqual(healthTags({}), [], "an older Worker sends no health");
  assert.deepEqual(
    orderScopes([scope("c", 0, 0), scope("b", 0, 1), scope("a", 0, 0), scope("d", 1, 0)]).map((each) => each.id),
    ["b", "d", "a", "c"],
  );
});

test("each team's org row counts its members' features by stage, what waits on them and its clean scopes", () => {
  const scopes = [
    { id: "money", name: "Money", dri: "ines", fallback: [], health: { waiting: 1, notInCode: 0 } },
    { id: "tax", name: "Tax", dri: "kofi", fallback: [], health: { waiting: 0, notInCode: 0 } },
  ];
  const view: TeamView = {
    people: [
      { id: "ines", role: { scopes: [], dependents: [], dependencies: [] }, features: [feature("money"), feature("old", { state: "promoted" })], idleAgents: [], waiting: [{ feature: "money", kind: "part", count: 2 }] },
      { id: "kofi", role: { scopes: [], dependents: [], dependencies: [] }, features: [feature("tax", { strip: strip("plan", 2, "person") })], idleAgents: [] },
    ],
    teams: [team("person:sam", "sam", ["sam"], { implicit: true }), team("payments", "ines", ["ines", "kofi"], { scopes })],
  };
  const rows = orgRows(view);
  assert.deepEqual(
    rows.map((row) => [row.team.id, row.people, row.stages.map((bucket) => `${bucket.label} ${bucket.features.length}`), row.waiting, row.clean, row.scopes]),
    [
      ["payments", 2, ["Review 1", "Review 1", "On main 1"], 2, 1, 2],
      ["person:sam", 0, [], 0, 0, 0],
    ],
  );
});

test("a feature page's anchor names the part and the file the breadcrumb shows", () => {
  const file = (path: string) => ({ path, scope: "tax", status: "modified" as const, hunks: [], omitted: null, omittedLines: 0, added: 1, removed: 0 });
  const part = { partId: "money/v1#3", place: { kind: "scope" as const, scope: "tax" }, files: [file("tax/totals.py"), file("tax/lines.py")] };
  const plan = { parts: [part] } as unknown as Parameters<typeof partCrumbs>[0];
  assert.deepEqual(partCrumbs(plan, "part-3"), [{ label: "#3 tax", anchor: "part-3" }]);
  assert.deepEqual(partCrumbs(plan, "part-3-file-2"), [
    { label: "#3 tax", anchor: "part-3" },
    { label: "lines.py", anchor: "part-3-file-2" },
  ]);
  for (const anchor of ["", "changes", "stage-review", "part-x", "part-3-file-", "part-4"]) assert.deepEqual(partCrumbs(plan, anchor), [], anchor);
  assert.deepEqual(partCrumbs(null, "part-3"), [], "a feature with no plan");
});

test("the org, team and person pages show the hierarchy in their breadcrumbs and rows open the level below", async () => {
  const { render } = await load<{ render: (view: TeamView) => { org: string; team: string; home: string; person: string } }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { OrgView } from "./src/org-page.tsx";
    import { PersonView } from "./src/person-page.tsx";
    import { TeamPageView } from "./src/team-page.tsx";
    export function render(view) {
      const navigate = () => {};
      return {
        org: renderToStaticMarkup(createElement(OrgView, { view, navigate })),
        team: renderToStaticMarkup(createElement(TeamPageView, { view, team: "payments", viewer: "kofi", navigate })),
        home: renderToStaticMarkup(createElement(TeamPageView, { view, team: null, viewer: "kofi", navigate })),
        person: renderToStaticMarkup(createElement(PersonView, { view, board: undefined, person: "ines", navigate, scopes: undefined })),
      };
    }`);
  const role = { scopes: [], dependents: [], dependencies: [] };
  const view: TeamView = {
    people: [
      {
        id: "ines",
        role,
        features: [feature("money", { strip: strip("split", 2, "person"), agents: [agent("@ines/money")] }), feature("tax", { state: "promoted", agents: [agent("@ines/tax")] })],
        idleAgents: [],
        steward: { handle: "@ines/steward", identityId: "s", online: true, running: 1, queued: 3, asked: 0, cap: 2 },
        waiting: [{ feature: "money", kind: "part", count: 2 }],
      },
      { id: "kofi", role, features: [], idleAgents: [] },
    ],
    teams: [team("payments", "ines", ["ines", "kofi"], { scopes: [{ id: "money", name: "Money", dri: "ines", fallback: [], reads: 0, readBy: 10, health: { waiting: 2, notInCode: 0 } }] })],
  };
  const pages = render(view);
  const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
  assert.match(text(pages.org), /^Org Org Teams 1 Team Lead Features by stage Waiting Health Payments 2 people I ines Migrate needs a person 1 On main 1 2 0 of 1 scopes clean$/u);
  assert.match(pages.org, /href="\/teams\/payments"/u);
  // The home page is the viewer's own team.
  assert.equal(pages.home, pages.team);
  assert.match(text(pages.team), /^Org Payments Payments Lead I ines Members 2 Person Features by stage Agents Waiting on them/u);
  assert.match(text(pages.team), /I ines Migrate needs a person 1 On main 1 steward ines 1 of 2 running 3 queued 1 builder 2 money 2 K kofi None None None/u);
  assert.match(text(pages.team), /Scopes 1 Scope DRI Reads Read by Health Money I ines 0 10 2 waiting$/u);
  // A stage pill of one feature opens that feature.
  assert.match(pages.team, /href="\/features\/money"/u);
  assert.match(text(pages.person), /^Org Payments ines I ines Waiting 2 money 2 parts Features 2 Needs a person 1 money/u);
  // The feature on main folds behind its count and lists no agents.
  assert.match(text(pages.person), /On main 1 Scopes/u);
  assert.doesNotMatch(text(pages.person), /tax ines/u);
});
