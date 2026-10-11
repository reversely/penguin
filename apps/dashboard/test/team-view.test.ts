import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, IdentitiesPage, IdentityEntry } from "@penguin/protocol";

import { assignPersonHues, fnv1a, PERSON_HUES, personHue, type PersonHue } from "../src/character.ts";
import { agentStatus, agentWork, heldIssues, personIssues, sessionIssue, teamMap, teamPeople } from "../src/team-view.ts";
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

test("every owner, scope owner and person asked to act gets a square, the viewer's first", () => {
  const map = teamMap(board(), page(["jun", "priya", "zoe"], ["@jun/reports"]), "priya");
  assert.deepEqual(
    map.people.map((entry) => entry.id),
    ["priya", "jun", "lee", "sam", "zoe"],
  );
  assert.deepEqual(
    map.unassigned.map((entry) => entry.issue.id),
    ["35"],
  );
});

test("an agent box carries its card's id, its most pressing status and its open issues", () => {
  const map = teamMap(board(), page([], ["@jun/reports"]), "jun");
  const jun = map.people.find((entry) => entry.id === "jun");
  assert.deepEqual(
    jun?.agents.map((agent) => [agent.identity.handle, agent.id, agent.status, agent.held.map((held) => held.issue.id)]),
    // Issue 32 blocks the session on Priya's reply, so it comes before 31, which waits at a checkpoint.
    [["@jun/reports", "identity-1", "blocked", ["32", "31"]]],
  );
  const priya = map.people.find((entry) => entry.id === "priya");
  assert.deepEqual(
    priya?.agents.map((agent) => [agent.identity.handle, agent.id, agent.status]),
    // The team identity sits under Priya, who assigned it its issue, and not under Jun. Agents with no
    // session follow by handle.
    [
      ["@jun/data-pair", null, "none"],
      ["@priya/merge-rules", null, "none"],
    ],
  );
});

test("a team identity holding nothing sits under every owner it serves", () => {
  const idle = { ...board(), issues: [] };
  const map = teamMap(idle, page([], []), "jun");
  const handles = (id: string) => map.people.find((entry) => entry.id === id)?.agents.map((agent) => agent.identity.handle);
  assert.deepEqual(handles("jun"), ["@jun/reports", "@jun/data-pair"]);
  assert.deepEqual(handles("priya"), ["@jun/data-pair", "@priya/merge-rules"]);
});

test("what needs a person counts reviews, threads still open on them and sessions to start", () => {
  const map = teamMap(board(), page([], []), "jun");
  const needs = (id: string) => map.people.find((entry) => entry.id === id)?.needs;
  assert.deepEqual(needs("priya"), { reviews: 1, threads: 1, sessions: 1 });
  // Lee's thread item is on an issue with no open thread that needs Lee.
  assert.deepEqual(needs("lee"), { reviews: 0, threads: 0, sessions: 0 });
  assert.deepEqual(needs("jun"), { reviews: 0, threads: 0, sessions: 0 });
});

test("an identity's status is its sessions' most pressing one, working with none routed and none offline", () => {
  const two = boardIdentity("@jun/reports", 2);
  assert.equal(agentStatus(two, new Map([["session-1", "done"], ["session-2", "waiting at a checkpoint"]])), "waiting at a checkpoint");
  assert.equal(agentStatus(two, new Map()), "working");
  assert.equal(agentStatus(boardIdentity("@jun/reports", 0), new Map()), "none");
});

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

test("the team's people are the map's squares", () => {
  const people = teamPeople(board(), page(["jun", "priya", "mia"], []));
  assert.deepEqual([...people].sort(), teamMap(board(), page(["jun", "priya", "mia"], []), "jun").people.map(({ id }) => id).sort());
});

test("the team map's squares and a person's badge on any page show the shell's one assignment", async () => {
  const { render } = await load<{ render: (board: Board, page: IdentitiesPage, ids: readonly string[]) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { PersonAvatar } from "./src/avatar.tsx";
    import { TeamHues, TeamMapView } from "./src/team-page.tsx";
    export function render(board, page, ids) {
      const team = { board: { kind: "ready", value: board }, identities: { kind: "ready", value: page } };
      return renderToStaticMarkup(createElement(TeamHues, { team },
        createElement(TeamMapView, { board, page, viewer: "jun", navigate() {} }),
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
