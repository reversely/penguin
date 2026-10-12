// PRD 0.5 core concepts and section 4.4a: teams own scopes; a decision goes to the scope's DRI, or
// down the fallback order when the DRI has no bridge online and no session.

import assert from "node:assert/strict";
import test from "node:test";

import { driScopes, parseScopeMap, parseTeams, protectedPathFor, routeScope, scopeForPath } from "@penguin/scope-map";

const teams = parseTeams({ teams: [{ id: "data", name: "Data", lead: "priya", members: ["priya", "jun"] }] });

const map = parseScopeMap(
  {
    scopes: [
      { id: "ingestion", name: "Ingestion", team: "data", dri: "priya", fallback: ["jun"], paths: ["ingestion/"], protected_paths: ["ingestion/schema/"], contracts: [], test_command: "true", depends_on: [] },
      { id: "analytics", name: "Analytics", team: "data", dri: "jun", fallback: ["priya"], paths: ["analytics/"], contracts: [], test_command: "true", depends_on: [{ scope: "ingestion", kind: "imports" }] },
      { id: "messaging", name: "Messaging", owner: "sam", paths: ["messaging/"], contracts: [], test_command: "true", depends_on: [] },
    ],
  },
  { teams },
);

test("a decision goes to the scope's DRI while the DRI is reachable", () => {
  assert.equal(routeScope(map, "analytics", () => true), "jun");
});

test("an unreachable DRI hands the decision to the first reachable fallback", () => {
  assert.equal(routeScope(map, "analytics", (person) => person !== "jun"), "priya");
});

test("with nobody reachable the decision stays with the DRI", () => {
  assert.equal(routeScope(map, "analytics", () => false), "jun");
});

test("a scope with only an owner reads as a one-person team with that owner as DRI", () => {
  assert.equal(routeScope(map, "messaging", () => false), "sam");
  assert.deepEqual(driScopes(map, "sam"), ["messaging"]);
});

test("a path belongs to the scope whose paths contain it", () => {
  assert.equal(scopeForPath(map, "analytics/retention.py"), "analytics");
  assert.equal(scopeForPath(map, "docs/readme.md"), undefined);
});

test("a protected path is found under its scope", () => {
  assert.equal(protectedPathFor(map, "ingestion/schema/v2.sql")?.scopeId, "ingestion");
  assert.equal(protectedPathFor(map, "ingestion/batches.py"), undefined);
});

test("a DRI outside the scope's team is refused", () => {
  assert.throws(() =>
    parseScopeMap({ scopes: [{ id: "x", name: "X", team: "data", dri: "sam", paths: ["x/"], contracts: [], test_command: "true", depends_on: [] }] }, { teams }),
  );
});
