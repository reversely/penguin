import assert from "node:assert/strict";
import { test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";

import { EMPTY_AREA, extendArea, FEATURE_LIMITS, FeatureStore, signFeatureRecord } from "../src/feature-store.ts";
import { sqlite } from "./issues-repo.ts";

test("a checkpoint's paths extend the area up to the cap; the rest are counted as omitted", () => {
  const declared = { scopes: ["billing"], paths: ["billing"], contracts: ["money/core.py::Money"] };
  const changed = ["billing/tax.py", "docs/a.md", ...Array.from({ length: FEATURE_LIMITS.recordedPaths }, (_, i) => `gen/${i}.py`)];
  const { area, omittedPaths } = extendArea(declared, ["docs", "gen"], changed);
  // billing/tax.py sits under the declared directory, so it adds nothing.
  assert.equal(area.paths.includes("billing/tax.py"), false);
  assert.equal(area.paths.length, FEATURE_LIMITS.recordedPaths);
  assert.equal(omittedPaths, changed.length - 1 - (FEATURE_LIMITS.recordedPaths - 1));
  assert.deepEqual(area.scopes, ["billing", "docs", "gen"]);
  assert.deepEqual(area.contracts, declared.contracts);
});

test("record ids count each author's records across features, so none repeats", async () => {
  const { privateKey } = await generateSigningKeyPair();
  const store = new FeatureStore(sqlite().sql);
  const author = { person: "ines" };
  const ids: string[] = [];
  for (const feature of ["a", "b"]) {
    const record = await signFeatureRecord(store.draftRecord(feature, "open_feature", author, {}), privateKey);
    assert.equal(store.insert(feature, "ines", EMPTY_AREA, record), true);
    ids.push(record.record_id);
  }
  assert.deepEqual(ids, ["ines-web-0001", "ines-web-0002"]);
  const again = await signFeatureRecord(store.draftRecord("a", "open_feature", author, {}), privateKey);
  assert.equal(store.insert("a", "ines", EMPTY_AREA, again), false);
  assert.equal(store.records("a").length, 1);
});
