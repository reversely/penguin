// Teams own scopes; each scope names a DRI and a fallback order (#135, PRD 0.5 core concepts and
// section 9). A scope that names only an owner reads as a one-person team, so every example fixture
// routes exactly as before.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  answerersOf,
  driScopes,
  inScopeTeam,
  ledScopes,
  parseScopeMap,
  parseTeams,
  routeScope,
  ScopeMapError,
  teamOfScope,
  TeamsError,
} from "@penguin/scope-map";

const read = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const teamFixture = new URL("../../../tests/fixtures/team-scopes/penguin/", import.meta.url);
const people = (read(new URL("owners.json", teamFixture)) as { owners: { id: string }[] }).owners.map((owner) => owner.id);
const teams = parseTeams(read(new URL("teams.json", teamFixture)), { ownerIds: people });
const map = parseScopeMap(read(new URL("scopes.json", teamFixture)), { ownerIds: people, teams });

const nobody = () => false;
const everybody = () => true;
const only = (...online: string[]) => (person: string) => online.includes(person);

test("the team fixture parses a two-person team with a lead outside it, a DRI and a fallback", () => {
  assert.deepEqual(teams.get("data-platform"), { id: "data-platform", name: "Data platform", leadId: "maya", memberIds: ["jun", "priya"], implicit: false });
  const identity = map.scopes.get("identity-map");
  assert.deepEqual([identity?.teamId, identity?.driId, identity?.fallbackIds], ["data-platform", "priya", ["jun"]]);
  const analytics = map.scopes.get("analytics");
  assert.deepEqual([analytics?.teamId, analytics?.driId, analytics?.fallbackIds], ["data-platform", "jun", []]);
  // A scope with only an owner sits beside them as that owner's one-person team.
  const messaging = map.scopes.get("messaging");
  assert.deepEqual([messaging?.teamId, messaging?.driId, messaging?.fallbackIds], ["person:sam", "sam", []]);
  assert.deepEqual(teamOfScope(map, "messaging"), { id: "person:sam", name: "sam", leadId: "sam", memberIds: ["sam"], implicit: true });
  assert.deepEqual(answerersOf(identity!), ["priya", "jun"]);
  assert.deepEqual(driScopes(map, "jun"), ["analytics"]);
});

test("a scope's decision goes to its DRI, then down its fallback order, else stays with the DRI", () => {
  assert.equal(routeScope(map, "identity-map", everybody), "priya");
  assert.equal(routeScope(map, "identity-map", only("priya")), "priya");
  assert.equal(routeScope(map, "identity-map", only("jun")), "jun", "the DRI has no bridge online and no session");
  assert.equal(routeScope(map, "identity-map", nobody), "priya", "nobody is back: the DRI keeps it");
  // A person excluded, such as the feature's own author, is never picked from the fallback order.
  assert.equal(routeScope(map, "identity-map", only("jun"), "jun"), "priya");
  assert.equal(routeScope(map, "analytics", only("priya")), "jun", "no fallback order: the DRI keeps it");
  assert.equal(routeScope(map, "ghost", everybody), undefined);
});

test("team membership and leadership come from the teams file", () => {
  assert.equal(inScopeTeam(map, "identity-map", "jun"), true);
  assert.equal(inScopeTeam(map, "analytics", "priya"), true);
  assert.equal(inScopeTeam(map, "identity-map", "sam"), false);
  assert.equal(inScopeTeam(map, "identity-map", "maya"), false, "the lead is not a member");
  assert.equal(inScopeTeam(map, "messaging", "sam"), true);
  assert.deepEqual(ledScopes(map, "maya"), ["analytics", "identity-map"]);
  assert.deepEqual(ledScopes(map, "sam"), ["messaging"]);
  assert.deepEqual(ledScopes(map, "priya"), []);
  // Read without its teams file, as the bridge does, a team's scopes still name their DRI and fallback.
  const bare = parseScopeMap(read(new URL("scopes.json", teamFixture)));
  assert.equal(routeScope(bare, "identity-map", only("jun")), "jun");
  assert.equal(inScopeTeam(bare, "identity-map", "jun"), true);
  assert.deepEqual(ledScopes(bare, "maya"), []);
});

test("every committed example fixture names only owners, so each scope routes to its owner as before", () => {
  const examples = new URL("../../../examples/", import.meta.url);
  const fixtures = readdirSync(examples, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  let checked = 0;
  for (const fixture of fixtures) {
    let json: { scopes: { id: string; owner: string }[] };
    try {
      json = read(new URL(`${fixture}/base/penguin/scopes.json`, examples)) as typeof json;
    } catch {
      continue;
    }
    const parsed = parseScopeMap(json, { teams: new Map() });
    for (const raw of json.scopes) {
      const scope = parsed.scopes.get(raw.id)!;
      assert.deepEqual([scope.driId, scope.fallbackIds, scope.teamId], [raw.owner, [], `person:${raw.owner}`], `${fixture} ${raw.id}`);
      for (const available of [everybody, nobody]) assert.equal(routeScope(parsed, raw.id, available), raw.owner);
      assert.deepEqual(ledScopes(parsed, raw.owner).includes(raw.id), true);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `checked ${checked} scopes`);
});

function assertRejected(run: () => unknown, kind: typeof ScopeMapError | typeof TeamsError, field: string): void {
  assert.throws(run, (error: unknown) => error instanceof kind && error.issues.some((issue) => issue.field === field), field);
}

test("a malformed teams file is refused naming the field", () => {
  const team = (changes: object) => ({ teams: [{ id: "data", name: "Data", lead: "maya", members: ["priya", "jun"], ...changes }] });
  assertRejected(() => parseTeams({}), TeamsError, "teams");
  assertRejected(() => parseTeams(team({ id: "Data Team" })), TeamsError, "teams[0].id");
  assertRejected(() => parseTeams(team({ id: "person:priya" })), TeamsError, "teams[0].id");
  assertRejected(() => parseTeams({ teams: [team({}).teams[0], team({}).teams[0]] }), TeamsError, "teams[1].id");
  assertRejected(() => parseTeams(team({ name: "" })), TeamsError, "teams[0].name");
  assertRejected(() => parseTeams(team({ lead: "" })), TeamsError, "teams[0].lead");
  assertRejected(() => parseTeams(team({ members: [] })), TeamsError, "teams[0].members");
  assertRejected(() => parseTeams(team({ members: ["priya", "priya"] })), TeamsError, "teams[0].members[1]");
  assertRejected(() => parseTeams(team({ members: ["ghost"] }), { ownerIds: people }), TeamsError, "teams[0].members[0]");
  assertRejected(() => parseTeams(team({ lead: "ghost" }), { ownerIds: people }), TeamsError, "teams[0].lead");
});

test("a scope's team, DRI and fallback are refused naming the field when they do not fit the teams", () => {
  const scope = (changes: object) => ({
    scopes: [{ id: "a", name: "a", team: "data-platform", dri: "priya", paths: ["a/"], test_command: "true", depends_on: [], ...changes }],
  });
  assert.doesNotThrow(() => parseScopeMap(scope({}), { teams }));
  assertRejected(() => parseScopeMap(scope({ team: "growth" }), { teams }), ScopeMapError, "scopes[0].team");
  assertRejected(() => parseScopeMap(scope({ dri: "sam" }), { teams }), ScopeMapError, "scopes[0].dri");
  assertRejected(() => parseScopeMap(scope({ dri: undefined }), { teams }), ScopeMapError, "scopes[0].dri");
  assertRejected(() => parseScopeMap(scope({ team: undefined }), { teams }), ScopeMapError, "scopes[0].team");
  assertRejected(() => parseScopeMap(scope({ fallback: ["sam"] }), { teams }), ScopeMapError, "scopes[0].fallback[0]");
  assertRejected(() => parseScopeMap(scope({ fallback: ["priya"] }), { teams }), ScopeMapError, "scopes[0].fallback[0]");
  assertRejected(() => parseScopeMap(scope({ fallback: ["jun", "jun"] }), { teams }), ScopeMapError, "scopes[0].fallback[1]");
  assertRejected(() => parseScopeMap(scope({ fallback: "jun" }), { teams }), ScopeMapError, "scopes[0].fallback");
  assertRejected(() => parseScopeMap(scope({ owner: "priya" }), { teams }), ScopeMapError, "scopes[0].owner");
  // A repo without a teams file has no declared team, so a scope naming one is refused.
  assertRejected(() => parseScopeMap(scope({}), { teams: new Map() }), ScopeMapError, "scopes[0].team");
  assertRejected(() => parseScopeMap(scope({ dri: "ghost" }), { ownerIds: people }), ScopeMapError, "scopes[0].dri");
});
