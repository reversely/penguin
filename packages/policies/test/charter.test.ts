import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { operationTargets, withinCharter, type CharterIdentity } from "@penguin/policies";
import { parseScopeMap } from "@penguin/scope-map";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(new URL("../../../examples/identity-unification/base/penguin/scopes.json", import.meta.url), "utf8"),
  ),
);

const reports: CharterIdentity = {
  handle: "@jun/reports",
  ownerId: "jun",
  teamOwners: [],
  charterScopes: ["analytics"],
  charterPaths: ["docs/metrics"],
};

const pair: CharterIdentity = {
  handle: "@jun/data-pair",
  ownerId: null,
  teamOwners: ["jun", "priya"],
  charterScopes: ["analytics", "identity-map"],
  charterPaths: ["docs/metrics"],
};

test("operationTargets names the scope of an added or removed scope label only", () => {
  assert.deepEqual(operationTargets({ type: "add_label", payload: { label: "scope:analytics" } }), {
    scopes: ["analytics"],
    paths: [],
  });
  assert.deepEqual(operationTargets({ type: "remove_label", payload: { label: "scope:messaging" } }).scopes, [
    "messaging",
  ]);
  assert.deepEqual(operationTargets({ type: "add_label", payload: { label: "huddle" } }).scopes, []);
  assert.deepEqual(operationTargets({ type: "comment", payload: { body: "scope:analytics" } }).scopes, []);
});

test("a personal identity may change its charter scopes, paths inside them and paths under its charter paths", () => {
  assert.deepEqual(withinCharter(reports, undefined, ["analytics"], ["analytics/retention.py"], scopeMap), {
    allowed: true,
  });
  assert.deepEqual(withinCharter(reports, undefined, [], ["docs/metrics/retention.md", "./docs/metrics"], scopeMap), {
    allowed: true,
  });
});

test("a scope or path outside a personal identity's charter is refused with a message naming the charter", () => {
  const verdict = withinCharter(reports, "jun", ["identity-map"], ["ingestion/ids.py", "docs/metricsx.md"], scopeMap);
  assert.deepEqual(verdict, {
    allowed: false,
    message:
      "@jun/reports acts outside its charter (scopes: analytics; paths: docs/metrics): " +
      "the operation names scope identity-map, path ingestion/ids.py, path docs/metricsx.md",
  });
});

test("a path that cannot be normalized is outside every charter", () => {
  for (const path of ["../analytics/x.py", "/analytics/x.py", ""]) {
    assert.equal(withinCharter(reports, undefined, [], [path], scopeMap).allowed, false, path);
  }
});

test("a team identity works only within the scopes of the owner who assigned it", () => {
  assert.equal(withinCharter(pair, "jun", ["analytics"], ["analytics/retention.py"], scopeMap).allowed, true);
  assert.equal(withinCharter(pair, "jun", ["identity-map"], [], scopeMap).allowed, false);
  assert.equal(withinCharter(pair, "jun", [], ["ingestion/ids.py"], scopeMap).allowed, false);
  assert.equal(withinCharter(pair, "priya", ["identity-map"], ["ingestion/ids.py"], scopeMap).allowed, true);
  assert.equal(withinCharter(pair, "priya", ["analytics"], [], scopeMap).allowed, false);
});

test("a team identity's charter paths count only inside the assigning owner's scopes", () => {
  // docs/metrics lies in no scope, so no assigning owner owns it.
  assert.equal(withinCharter(pair, "jun", [], ["docs/metrics/retention.md"], scopeMap).allowed, false);
});

test("a team identity not assigned by one of its owners changes nothing", () => {
  const unassigned = withinCharter(pair, undefined, ["analytics"], [], scopeMap);
  assert.equal(unassigned.allowed, false);
  assert.match(!unassigned.allowed ? unassigned.message : "", /none of its owners has/u);
  const bySam = withinCharter(pair, "sam", ["analytics"], [], scopeMap);
  assert.match(!bySam.allowed ? bySam.message : "", /works only for its owners \(jun, priya\), and sam assigned it/u);
});

test("an empty request is within every charter", () => {
  assert.equal(withinCharter(pair, undefined, [], [], scopeMap).allowed, true);
});

test("charter check time per operation", (t) => {
  const runs = 20_000;
  const started = performance.now();
  for (let i = 0; i < runs; i++) {
    const scope = i % 2 === 0 ? "analytics" : "identity-map";
    const targets = operationTargets({ type: "add_label", payload: { label: `scope:${scope}` } });
    withinCharter(pair, "jun", targets.scopes, targets.paths, scopeMap);
  }
  const perOp = ((performance.now() - started) / runs) * 1000;
  t.diagnostic(`charter check: ${perOp.toFixed(2)} µs per operation over ${runs} team-identity label operations`);
});
