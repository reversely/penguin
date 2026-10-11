// The overlap rules (PRD 0.4 section 4.1 step 3) on a scope map the test builds, and the comparison
// timed against 40 running features, the scale of PRD section 1 case 4.

import assert from "node:assert/strict";
import { test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { EMPTY_AREA, FEATURE_LIMITS, FeatureStore, signFeatureRecord, type Feature, type FeatureArea } from "../src/feature-store.ts";
import { checkOverlap, findOverlaps, OverlapStore } from "../src/overlap-lock.ts";
import { sqlite } from "./issues-repo.ts";

/** `count` scopes `s0`..`sN`, each owning `src/s<i>` with one contract; scope i+1 reads scope i. */
function scopeMapOf(count: number): ScopeMap {
  return parseScopeMap({
    scopes: Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      name: `Scope ${i}`,
      owner: `p${i}`,
      paths: [`src/s${i}/`],
      test_command: "true",
      contracts: [`src/s${i}/api.py::call`],
      depends_on: i === 0 ? [] : [{ scope: `s${i - 1}`, kind: "imports" }],
    })),
  });
}

const map = scopeMapOf(4);

function feature(id: string, personId: string, area: Partial<FeatureArea>): Feature {
  const now = new Date(0).toISOString();
  return {
    id,
    personId,
    repo: `feature-${id}`,
    area: { ...EMPTY_AREA, ...area },
    state: "building",
    openedAt: now,
    latestCheckpointSha: null,
    updatedAt: now,
  };
}

const covers = (mine: Partial<FeatureArea>, theirs: Partial<FeatureArea>) =>
  findOverlaps(feature("new", "a", mine), [feature("old", "b", theirs)], map).covering.length === 1;

test("a declared scope covers every path, contract and scope in it", () => {
  assert.equal(covers({ scopes: ["s1"] }, { scopes: ["s1"] }), true);
  assert.equal(covers({ paths: ["src/s1/x.py"] }, { scopes: ["s1"] }), true);
  assert.equal(covers({ scopes: ["s1"] }, { contracts: ["src/s1/api.py::call"] }), true);
  // A directory above a scope's own path holds that scope.
  assert.equal(covers({ paths: ["src"] }, { scopes: ["s2"] }), true);
  assert.equal(covers({ scopes: ["s1"] }, { scopes: ["s2"], paths: ["src/s3/y.py"] }), false);
});

test("paths overlap only when one contains the other; two files of one scope are apart", () => {
  assert.equal(covers({ paths: ["src/s1/x.py"] }, { paths: ["src/s1/x.py"] }), true);
  assert.equal(covers({ paths: ["src/s1"] }, { paths: ["src/s1/deep/x.py"] }), true);
  assert.equal(covers({ paths: ["src/s1/deep/x.py"] }, { paths: ["src/s1"] }), true);
  assert.equal(covers({ paths: ["src/s1/x.py"] }, { paths: ["src/s1/y.py"] }), false);
  // A shared prefix of characters is no shared directory.
  assert.equal(covers({ paths: ["src/s1/x"] }, { paths: ["src/s1/xy.py"] }), false);
});

test("contracts overlap by name or by a path that holds them", () => {
  assert.equal(covers({ contracts: ["src/s1/api.py::call"] }, { contracts: ["src/s1/api.py::call"] }), true);
  assert.equal(covers({ contracts: ["src/s1/api.py::call"] }, { paths: ["src/s1/api.py"] }), true);
  assert.equal(covers({ paths: ["src/s1"] }, { contracts: ["src/s1/api.py::call"] }), true);
  assert.equal(covers({ contracts: ["src/s1/api.py::call"] }, { contracts: ["src/s2/api.py::call"] }), false);
});

test("the overlap names where the areas meet", () => {
  const [found] = findOverlaps(
    feature("new", "a", { paths: ["src/s1/x.py", "src/s3/z.py"], contracts: ["src/s2/api.py::call"] }),
    [feature("old", "b", { scopes: ["s1"], paths: ["src/s2"] })],
    map,
  ).covering;
  assert.deepEqual(found?.overlap, { scopes: ["s1"], paths: ["src/s1/x.py"], contracts: ["src/s2/api.py::call"], omittedPaths: 0 });
});

test("dependents are running features in a scope whose depends_on names a scope the area falls in", () => {
  const findings = findOverlaps(
    feature("new", "a", { paths: ["src/s1/x.py"] }),
    [feature("reader", "b", { scopes: ["s2"] }), feature("unrelated", "c", { scopes: ["s0"] }), feature("new", "a", {})],
    map,
  );
  assert.deepEqual(findings.covering, []);
  assert.deepEqual(findings.dependents, [{ dependentFeatureId: "reader", consumerScopeId: "s2", providerScopeId: "s1", kind: "imports" }]);
});

test(
  "the comparison against 40 running features is timed",

  async (t) => {
    const big = scopeMapOf(40);
    // Each running feature declares one scope, a directory, 50 files and a contract of its own scope.
    const running = Array.from({ length: 40 }, (_, i) =>
      feature(`f${i}`, `p${i}`, {
        scopes: [`s${i}`],
        paths: [`src/s${i}/pkg`, ...Array.from({ length: 50 }, (_, j) => `src/s${i}/mod/m${j}.py`)],
        contracts: [`src/s${i}/api.py::call`],
      }),
    );
    // The new feature touches files in every scope, so every pair is compared in full.
    const declared = feature("new", "q", {
      paths: Array.from({ length: FEATURE_LIMITS.paths }, (_, j) => `src/s${j % 40}/other/n${j}.py`),
    });
    const runs = 20;
    let started = performance.now();
    for (let run = 0; run < runs; run += 1) findOverlaps(declared, running, big);
    const typical = (performance.now() - started) / runs;

    // The cap: every running feature at the recorded-path limit after many checkpoints.
    const full = running.map((each, i) =>
      feature(each.id, each.personId, {
        ...each.area,
        paths: Array.from({ length: FEATURE_LIMITS.recordedPaths }, (_, j) => `src/s${i}/gen/d${j % 20}/g${j}.py`),
      }),
    );
    started = performance.now();
    const findings = findOverlaps(declared, full, big);
    const worst = performance.now() - started;
    assert.equal(findings.covering.length, 40);

    // The whole check with its SQL writes and signed record, as the ProjectAgent runs it.
    const { privateKey } = await generateSigningKeyPair();
    const db = sqlite().sql;
    const features = new FeatureStore(db);
    const record = (id: string) => signFeatureRecord(features.draftRecord(id, "open_feature", { person: "q" }, {}), privateKey);
    for (const each of [...running, declared]) features.insert(each.id, each.personId, each.area, await record(each.id));
    for (const each of running) features.setRepo(each.id, each.repo as string);
    const overlaps = new OverlapStore(db);
    started = performance.now();
    const status = await checkOverlap(
      { db, features, overlaps, scopeMap: async () => big, sign: (draft) => signFeatureRecord(draft, privateKey) },
      features.get("new") as Feature,
    );
    const whole = performance.now() - started;
    assert.equal(status.waitingOn.length, 40);

    t.diagnostic(
      `overlap comparison, 256 declared paths against 40 running features: ${typical.toFixed(2)} ms; ` +
        `with each at ${FEATURE_LIMITS.recordedPaths} paths: ${worst.toFixed(2)} ms; ` +
        `whole check with storage and a signed record: ${whole.toFixed(2)} ms`,
    );
  },
);
