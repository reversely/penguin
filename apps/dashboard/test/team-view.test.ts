import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, IdentitiesPage, IdentityEntry } from "@penguin/protocol";

import { assignPersonHues, fnv1a, PERSON_HUES, personHue, type PersonHue } from "../src/character.ts";
import { agentWork, heldIssues, personIssues, sessionIssue, teamPeople } from "../src/team-view.ts";
import { boardIdentity, identity, issue, person, running, thread } from "./board-fixtures.ts";
import { load } from "./render.ts";

function page(owners: string[], handles: string[]): IdentitiesPage {
  return {
    identities: handles.map((handle, n): IdentityEntry => ({
      id: `identity-${n + 1}`,
      handle,
      name: handle,
      avatar: null,
      job: "",
      team: false,
      owners: [handle.slice(1, handle.indexOf("/"))],
      charterScopes: [],
      charterPaths: [],
      charterRules: [],
      autoAccept: true,
      duplicatedFrom: null,
      sessions: [],
      history: [],
      lastCheckpoint: null,
      recentOperations: [],
    })),
    scopes: [],
    owners,
    limits: { nameLength: 1, jobLength: 1, rules: 1, ruleLength: 1, scopes: 1, paths: 1, pathLength: 1, teamOwners: 1, avatarBytes: 1 },
  };
}

const offline = { ...running, status: "offline" as const };

/** Jun with a running agent on two issues, Priya with an idle agent, and a team identity of both. */
function board(): Board {
  const pair = boardIdentity("@jun/data-pair", 0, true);
  return {
    owners: [
      { id: "jun", identities: [boardIdentity("@jun/reports"), pair] },
      { id: "priya", identities: [boardIdentity("@priya/merge-rules", 0), pair] },
      // The board lists an owner with no identity whose lane holds an issue.
      { id: "sam", identities: [] },
    ],
    issues: [
      issue("31", "verifying", { assignees: [identity("@jun/reports")] }),
      issue("32", "fixing", { assignees: [identity("@jun/reports")], threads: [thread({ needsPersonIds: ["priya"] })] }),
      issue("33", "closed", { assignees: [identity("@jun/reports")] }),
      issue("34", "fixing", { assignees: [identity("@jun/data-pair", null)] }, { laneOwners: { "@jun/data-pair": ["priya"] } }),
      issue("35", "open"),
      issue("36", "fixing", { assignees: [person("sam")] }),
    ],
    waiting: [
      { personId: "priya", issueId: "32", reason: "thread" },
      { personId: "priya", issueId: "31", reason: "review_requested" },
      { personId: "priya", issueId: "34", reason: "start_session" },
      { personId: "lee", issueId: "35", reason: "thread" },
    ],
  };
}

test("a person's issues are those assigned to them or their agents or waiting on them, open first and newest first", () => {
  const rows = (id: string) => personIssues(board(), id).map((row) => [row.issue.issue.id, row.involvement]);
  assert.deepEqual(rows("jun"), [
    ["32", ["assigned"]],
    ["31", ["assigned"]],
    ["33", ["assigned"]],
  ]);
  assert.deepEqual(rows("priya"), [
    ["34", ["assigned", "session"]],
    ["32", ["reply"]],
    ["31", ["review"]],
  ]);
  assert.deepEqual(rows("sam"), [["36", ["assigned"]]]);
  assert.deepEqual(rows("nobody"), []);
});

test("an agent's work is its most pressing open issue, what that waits on and the rest it holds", () => {
  const work = agentWork(board(), "@jun/reports");
  assert.equal(work.issue?.issue.id, "32");
  assert.equal(work.waitsOn, "Reply from priya");
  assert.deepEqual(
    work.others.map((held) => held.issue.id),
    ["31"],
  );
  assert.deepEqual(agentWork(board(), "@priya/merge-rules"), { issue: null, waitsOn: null, others: [] });
  const stalled = { ...board(), issues: [issue("40", "fixing", { assignees: [identity("@jun/reports", offline)] })] };
  assert.equal(agentWork(stalled, "@jun/reports").waitsOn, "A running session");
  assert.deepEqual(
    heldIssues(stalled, "@jun/reports").map((held) => held.issue.id),
    ["40"],
  );
});

test("a session's issue is its delivered fix task, else the open issue routed to it", () => {
  const session = { id: "session-1", currentIssueId: null };
  assert.equal(sessionIssue(board(), "@jun/reports", session), "32");
  assert.equal(sessionIssue(board(), "@jun/reports", { ...session, currentIssueId: "40" }), "40");
  assert.equal(sessionIssue(board(), "@jun/reports", { ...session, id: "session-9" }), null);
  assert.equal(sessionIssue(undefined, "@jun/reports", session), null);
});

/** The hue an owner id hashes to before any other owner is considered. */
function hashed(id: string): string {
  return PERSON_HUES[fnv1a(id) % PERSON_HUES.length]!;
}

/** Teams of every size up to the palette's, drawn from a pool whose hashes clash often. */
const pool = Array.from({ length: 40 }, (_, n) => `owner-${n}`);
const teams = Array.from({ length: 300 }, (_, n) => pool.filter((_, at) => (fnv1a(`${n}:${at}`) & 3) === 0).slice(0, 1 + (n % PERSON_HUES.length)));

test("no two people on a team of up to the palette's size share a hue", () => {
  assert.equal(PERSON_HUES.length, 8);
  assert.ok(teams.some((team) => team.length === PERSON_HUES.length), "some teams fill the palette");
  assert.ok(teams.some((team) => new Set(team.map(hashed)).size < team.length), "some teams' hashes clash");
  for (const team of teams) {
    const hues = assignPersonHues(team);
    assert.equal(new Set(hues.values()).size, team.length, team.join(","));
  }
});

test("a new person whose hashed hue is free leaves every other person's hue as it was", () => {
  let free = 0;
  let clashed = 0;
  for (const team of teams.filter((members) => members.length < PERSON_HUES.length)) {
    const before = assignPersonHues(team);
    for (const added of pool.filter((id) => !team.includes(id))) {
      const after = assignPersonHues([...team, added]);
      if ([...before.values()].includes(hashed(added) as PersonHue)) {
        clashed += 1;
        continue;
      }
      free += 1;
      assert.equal(after.get(added), hashed(added));
      for (const [id, hue] of before) assert.equal(after.get(id), hue, `${id} after adding ${added}`);
    }
  }
  assert.ok(free > 0 && clashed > 0, `free ${free}, clashed ${clashed}`);
});

test("the same team gives the same hues whatever order its ids arrive in, and a repeated id counts once", () => {
  for (const team of teams) {
    const hues = assignPersonHues(team);
    assert.deepEqual(new Map([...assignPersonHues([...team].reverse())].sort()), new Map([...hues].sort()));
    assert.deepEqual(assignPersonHues([...team, ...team]), hues);
  }
});

test("a person outside the team takes the hue their id hashes to and moves no one else's", () => {
  const hues = assignPersonHues(["jun", "priya", "sam"]);
  assert.equal(personHue("<em>x</em>", hues), hashed("<em>x</em>"));
  assert.equal(personHue("jun", new Map()), hashed("jun"));
  assert.deepEqual(assignPersonHues(["jun", "priya", "sam"]), hues);
  for (const id of ["jun", "priya", "sam"]) assert.equal(personHue(id, hues), hues.get(id));
});

test("past the palette's size hues repeat as evenly as they can", () => {
  const hues = assignPersonHues(pool.slice(0, 19));
  const counts = PERSON_HUES.map((hue) => [...hues.values()].filter((held) => held === hue).length);
  assert.deepEqual([...counts].sort(), [2, 2, 2, 2, 2, 3, 3, 3]);
});

test("the team map's squares and a person's badge on any page show the shell's one assignment", async () => {
  const { render } = await load<{ render: (board: Board, page: IdentitiesPage, ids: readonly string[]) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { PersonAvatar } from "./src/avatar.tsx";
    import { TeamHues, TeamMapView } from "./src/team-page.tsx";
    export function render(board, page, ids) {
      const role = { scopes: [], dependents: [], dependencies: [] };
      const view = { people: ids.filter((id) => id !== "outsider").map((id) => ({ id, role, features: [], idleAgents: [] })) };
      const team = { view: { kind: "ready", value: view }, board: { kind: "ready", value: board }, identities: { kind: "ready", value: page } };
      return renderToStaticMarkup(createElement(TeamHues, { team },
        createElement(TeamMapView, { view, navigate() {} }),
        ...ids.map((id) => createElement("p", { key: id, "data-badge": id }, createElement(PersonAvatar, { id, size: "card" })))));
    }`);
  const owners = ["jun", "priya", "sam", "lee", "mia", "ana", "kai", "noor"];
  const team = page(owners, []);
  const html = render(board(), team, [...owners, "outsider"]);
  const squares = new Map(
    [...html.matchAll(/class="person-square person-(\w+)">.*?avatar-initial person-(\w+)".*?person-square-name">([^<]+)</g)].map(
      ([, square = "", badge = "", id = ""]) => {
        assert.equal(badge, square, `${id}'s badge and square`);
        return [id, square];
      },
    ),
  );
  const badges = new Map([...html.matchAll(/data-badge="([^"]+)"><span class="[^"]*person-(\w+)"/g)].map(([, id = "", hue = ""]) => [id, hue]));
  const assigned = assignPersonHues(teamPeople(board(), team));
  assert.equal(squares.size, owners.length);
  assert.equal(new Set(squares.values()).size, owners.length, "eight people, eight hues");
  for (const id of owners) {
    assert.equal(squares.get(id), assigned.get(id), id);
    assert.equal(badges.get(id), assigned.get(id), id);
  }
  assert.equal(badges.get("outsider"), hashed("outsider"));
});

test("a person's steward shows once, on the Steward row with its queue, and not among the agents on no feature", async () => {
  const { render } = await load<{ render: (steward: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { TeamMapView } from "./src/team-page.tsx";
    export function render(steward) {
      const role = { scopes: [], dependents: [], dependencies: [] };
      const idleAgents = [{ handle: "@jun/steward", identityId: "i1", person: "jun", online: false }, { handle: "@jun/reports", identityId: "i2", person: "jun", online: false }];
      const view = { people: [{ id: "jun", role, steward, features: [], idleAgents }] };
      return renderToStaticMarkup(createElement(TeamMapView, { view, navigate() {} }));
    }`);
  const html = render({ handle: "@jun/steward", identityId: "i1", online: false, running: 1, queued: 0, asked: 2, cap: 2 });
  assert.match(html, /<dt>Steward<\/dt>/u);
  const text = html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  assert.match(text, /steward jun 1 of 2 running 2 asked/u);
  assert.doesNotMatch(text, /queued/u);
  assert.equal(text.match(/steward jun/gu)?.length, 1, "the steward shows once");
  assert.match(text, /reports jun/u);
  // A person with no steward, or a view from an older Worker, has no Steward row.
  assert.doesNotMatch(render(null), /Steward/u);
  assert.doesNotMatch(render(undefined), /Steward/u);
});
