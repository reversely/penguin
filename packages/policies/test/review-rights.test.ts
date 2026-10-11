import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { labelledScopes, reviewRight } from "@penguin/policies";
import { parseScopeMap } from "@penguin/scope-map";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(new URL("../../../examples/identity-unification/base/penguin/scopes.json", import.meta.url), "utf8"),
  ),
);

test("labelledScopes reads scope:<id> labels only, once each", () => {
  assert.deepEqual(labelledScopes(["huddle", "scope:analytics", "scope:messaging", "scope:analytics"]), [
    "analytics",
    "messaging",
  ]);
});

test("the owner of a labelled scope may review", () => {
  const right = reviewRight({ person: "priya" }, ["scope:identity-map", "scope:analytics"], scopeMap);
  assert.deepEqual(right, { allowed: true, owner: "priya", scopes: ["identity-map"] });
});

test("an owner of no labelled scope may not review", () => {
  const right = reviewRight({ person: "sam" }, ["scope:identity-map", "scope:analytics"], scopeMap);
  assert.equal(right.allowed, false);
  assert.match(!right.allowed ? right.message : "", /sam owns no scope labelled on this issue/u);
});

test("an issue without scope labels grants no review right", () => {
  assert.equal(reviewRight({ person: "priya" }, ["huddle"], scopeMap).allowed, false);
});

test("a label naming a scope missing from the map grants nothing", () => {
  assert.equal(reviewRight({ person: "priya" }, ["scope:ghost"], scopeMap).allowed, false);
});

test("identities and Penguin hold no review right", () => {
  assert.equal(reviewRight({ identity: "@priya/merge-rules" }, ["scope:identity-map"], scopeMap).allowed, false);
  assert.equal(reviewRight({ penguin: true }, ["scope:identity-map"], scopeMap).allowed, false);
});
