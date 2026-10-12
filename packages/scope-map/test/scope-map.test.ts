import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  affectedOwners,
  dependentsOf,
  InvalidPathError,
  normalizeRepoPath,
  parseScopeMap,
  protectedPathFor,
  ScopeMapError,
  scopeForPath,
} from "@penguin/scope-map";

const fixtureDir = new URL("../../../examples/identity-unification/base/penguin/", import.meta.url);
const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));

const fixtureScopes = readFixture("scopes.json");
const fixtureOwnerIds = (readFixture("owners.json") as { owners: { id: string }[] }).owners.map(
  (owner) => owner.id,
);
const map = parseScopeMap(fixtureScopes, { ownerIds: fixtureOwnerIds });

function scopeFile(scopes: object[]): unknown {
  return { scopes };
}

function scope(id: string, owner: unknown, paths: string[], dependsOn: object[] = []): object {
  return { id, name: id, owner, paths, test_command: "true", depends_on: dependsOn };
}

function assertRejected(json: unknown, field: string, options = {}): void {
  assert.throws(
    () => parseScopeMap(json, options),
    (error: unknown) =>
      error instanceof ScopeMapError &&
      error.issues.some((issue) => issue.field === field) &&
      error.message.includes(field),
  );
}

test("the fixture scope file parses into three scopes", () => {
  assert.deepEqual([...map.scopes.keys()].sort(), ["analytics", "identity-map", "messaging"]);
  const identityMap = map.scopes.get("identity-map");
  assert.equal(identityMap?.ownerId, "priya");
  assert.deepEqual(identityMap?.paths, ["ingestion"]);
  assert.equal(identityMap?.testCommand, "python -m pytest ingestion");
  assert.deepEqual(map.scopes.get("analytics")?.dependsOn, [
    { consumerScopeId: "analytics", providerScopeId: "identity-map", kind: "imports" },
  ]);
});

test("scopeForPath maps a path to the scope whose prefix contains it", () => {
  assert.equal(scopeForPath(map, "ingestion/identity_map.py"), "identity-map");
  assert.equal(scopeForPath(map, "./analytics//models/x.py"), "analytics");
  assert.equal(scopeForPath(map, "messaging"), "messaging");
  assert.equal(scopeForPath(map, "ingestion_old/x.py"), undefined);
  assert.equal(scopeForPath(map, "README.md"), undefined);
});

test("dependentsOf lists the scopes that declare a dependency", () => {
  assert.deepEqual([...dependentsOf(map, "identity-map")].sort(), ["analytics", "messaging"]);
  assert.deepEqual(dependentsOf(map, "analytics"), []);
});

test("a change in identity-map affects owners jun and sam", () => {
  const result = affectedOwners(map, ["ingestion/identity_map.py"]);
  assert.deepEqual(result.owners, ["jun", "sam"]);
  assert.deepEqual(result.changedScopes, ["identity-map"]);
  assert.deepEqual(result.dependentScopes, ["analytics", "messaging"]);
  assert.deepEqual(result.unmapped, []);
});

test("a change in analytics affects no dependent owners", () => {
  const result = affectedOwners(map, ["analytics/models.py"]);
  assert.deepEqual(result.owners, []);
  assert.deepEqual(result.changedScopes, ["analytics"]);
});

test("a path inside no scope is returned as unmapped", () => {
  const result = affectedOwners(map, ["README.md", "analytics/models.py", "./README.md"]);
  assert.deepEqual(result.unmapped, ["README.md"]);
  assert.deepEqual(result.owners, []);
});

test("a scope with a missing owner is rejected naming the field", () => {
  assertRejected(scopeFile([scope("a", undefined, ["a/"])]), "scopes[0].owner");
  assertRejected(scopeFile([scope("a", "", ["a/"])]), "scopes[0].owner");
});

test("a scope whose owner is not in owners.json is rejected naming the field", () => {
  assertRejected(scopeFile([scope("a", "nobody", ["a/"])]), "scopes[0].owner", {
    ownerIds: fixtureOwnerIds,
  });
});

test("an unknown dependency is rejected naming the field", () => {
  const json = scopeFile([scope("a", "priya", ["a/"], [{ scope: "ghost", kind: "imports" }])]);
  assertRejected(json, "scopes[0].depends_on[0].scope");
});

test("a self dependency and a repeated dependency are rejected", () => {
  const self = scopeFile([scope("a", "priya", ["a/"], [{ scope: "a", kind: "imports" }])]);
  assertRejected(self, "scopes[0].depends_on[0].scope");
  const repeated = scopeFile([
    scope("a", "priya", ["a/"]),
    scope(
      "b",
      "jun",
      ["b/"],
      [
        { scope: "a", kind: "imports" },
        { scope: "a", kind: "imports" },
      ],
    ),
  ]);
  assertRejected(repeated, "scopes[1].depends_on[1].scope");
});

test("a path claimed by two scopes is rejected naming the field", () => {
  const same = scopeFile([scope("a", "priya", ["shared/"]), scope("b", "jun", ["./shared"])]);
  assertRejected(same, "scopes[1].paths[0]");
  const nestedAfter = scopeFile([scope("a", "priya", ["lib/"]), scope("b", "jun", ["lib/x/"])]);
  assertRejected(nestedAfter, "scopes[1].paths[0]");
  const nestedBefore = scopeFile([scope("a", "priya", ["lib/x/"]), scope("b", "jun", ["lib/"])]);
  assertRejected(nestedBefore, "scopes[1].paths[0]");
  const siblings = scopeFile([scope("a", "priya", ["lib/"]), scope("b", "jun", ["lib2/"])]);
  assert.doesNotThrow(() => parseScopeMap(siblings));
});

test("other malformed fields are rejected naming the field", () => {
  assertRejected({}, "scopes");
  assertRejected(scopeFile([scope("a", "priya", [])]), "scopes[0].paths");
  assertRejected(scopeFile([scope("a", "priya", ["/etc/"])]), "scopes[0].paths[0]");
  assertRejected(
    scopeFile([scope("a", "priya", ["a/"]), scope("a", "jun", ["b/"])]),
    "scopes[1].id",
  );
  assertRejected(
    scopeFile([{ id: "a", name: "a", owner: "priya", paths: ["a/"], depends_on: [] }]),
    "scopes[0].test_command",
  );
});

test("the lookup rejects absolute paths and any path containing '..'", () => {
  for (const bad of [
    "/etc/passwd",
    "C:\\repo\\x.py",
    "\\\\server\\share",
    "../outside.py",
    "ingestion/../../x",
    "ingestion\\..\\..\\x",
    "",
    ".",
    "a\0b",
  ]) {
    assert.throws(() => scopeForPath(map, bad), InvalidPathError, JSON.stringify(bad));
    assert.throws(() => affectedOwners(map, [bad]), InvalidPathError, JSON.stringify(bad));
  }
});

test("normalizeRepoPath collapses separators and dot segments", () => {
  assert.equal(normalizeRepoPath("./ingestion//ids.py"), "ingestion/ids.py");
  assert.equal(normalizeRepoPath("ingestion\\ids.py"), "ingestion/ids.py");
  assert.equal(normalizeRepoPath("ingestion/"), "ingestion");
});

test("a scope lists its contracts as path::symbol, normalized and indexed by scope", () => {
  const withContracts = parseScopeMap(
    scopeFile([
      { ...scope("money", "ines", ["money/"]), contracts: ["./money/core.py::Money.add", "money/core.py::round_half_even"] },
      scope("billing", "rahul", ["billing/"], [{ scope: "money", kind: "imports" }]),
    ]),
  );
  assert.deepEqual(withContracts.scopes.get("money")?.contracts, ["money/core.py::Money.add", "money/core.py::round_half_even"]);
  assert.deepEqual(withContracts.scopes.get("billing")?.contracts, []);
  assert.equal(withContracts.contracts.get("money/core.py::Money.add"), "money");
  // The identity-unification fixture declares contracts for each of its three scopes.
  assert.equal(map.contracts.get("analytics/models.py::daily_active_users"), "analytics");
  assert.equal(map.contracts.get("ingestion/identity_map.py::IdentityMap"), "identity-map");
});

test("a contract outside its scope's paths, malformed or repeated is refused", () => {
  const file = (contracts: unknown) =>
    scopeFile([{ ...scope("money", "ines", ["money/"]), contracts }, scope("billing", "rahul", ["billing/"])]);
  assertRejected(file(["billing/x.py::f"]), "scopes[0].contracts[0]");
  assertRejected(file(["money/core.py"]), "scopes[0].contracts[0]");
  assertRejected(file(["../money/core.py::f"]), "scopes[0].contracts[0]");
  assertRejected(file(["money/core.py::<script>"]), "scopes[0].contracts[0]");
  assertRejected(file(["money/core.py::f", "money//core.py::f"]), "scopes[0].contracts[1]");
  assertRejected(file("money/core.py::f"), "scopes[0].contracts");
});

test("a scope lists the paths its owner protects, each inside the scope", () => {
  const withProtected = parseScopeMap(
    scopeFile([
      { ...scope("analytics", "jun", ["analytics/"]), protected_paths: ["./analytics/revenue_report.py", "analytics/exports/"] },
      scope("tax", "rahul", ["tax/"]),
    ]),
  );
  assert.deepEqual(withProtected.scopes.get("analytics")?.protectedPaths, ["analytics/revenue_report.py", "analytics/exports"]);
  assert.deepEqual(withProtected.scopes.get("tax")?.protectedPaths, []);
  assert.deepEqual(protectedPathFor(withProtected, "analytics/revenue_report.py"), { scopeId: "analytics", path: "analytics/revenue_report.py" });
  assert.deepEqual(protectedPathFor(withProtected, "analytics/exports/daily.py"), { scopeId: "analytics", path: "analytics/exports" });
  assert.equal(protectedPathFor(withProtected, "analytics/revenue_report_v2.py"), undefined);
  assert.equal(protectedPathFor(withProtected, "tax/rounding.py"), undefined);
  assert.equal(protectedPathFor(withProtected, "docs/readme.md"), undefined);

  const file = (protectedPaths: unknown) => scopeFile([{ ...scope("analytics", "jun", ["analytics/"]), protected_paths: protectedPaths }, scope("tax", "rahul", ["tax/"])]);
  assertRejected(file(["tax/rounding.py"]), "scopes[0].protected_paths[0]");
  assertRejected(file(["../analytics/x.py"]), "scopes[0].protected_paths[0]");
  assertRejected(file(["analytics/x.py", "analytics//x.py"]), "scopes[0].protected_paths[1]");
  assertRejected(file([7]), "scopes[0].protected_paths[0]");
  assertRejected(file("analytics/x.py"), "scopes[0].protected_paths");
});

test("lookup time for one thousand changed paths", (t) => {
  const paths = Array.from({ length: 1000 }, (_, index) => {
    const root = ["ingestion", "analytics", "messaging", "docs"][index % 4];
    return `${root}/pkg${index % 17}/module_${index}.py`;
  });
  const start = performance.now();
  const result = affectedOwners(map, paths);
  const elapsedMs = performance.now() - start;
  t.diagnostic(`affectedOwners over 1000 changed paths: ${elapsedMs.toFixed(2)} ms`);
  assert.deepEqual(result.owners, ["jun", "sam"]);
  assert.equal(result.unmapped.length, 250);
});
