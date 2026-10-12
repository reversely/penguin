// The stage a feature is in, as the feature page, the team page and the org page count it (PRD 0.5
// section 10). The labels must read the way an engineering manager would read them: Building for work
// that reaches no one else, Plan only when a plan is needed, Promoted only once main has moved.

import assert from "node:assert/strict";
import test from "node:test";

import { featurePipeline, pipelineStrip, type PipelineFacts } from "@penguin/protocol";

function facts(overrides: Partial<PipelineFacts> = {}): PipelineFacts {
  return {
    person: "jun",
    state: "building",
    records: [],
    factsRun: "reported",
    places: 0,
    locks: [],
    expandLocks: [],
    parts: [],
    reviews: [],
    writes: new Map(),
    checks: null,
    checkRuns: [],
    protectedChanges: [],
    stopped: [],
    split: null,
    ...overrides,
  };
}

const current = (input: PipelineFacts) => {
  const strip = pipelineStrip(featurePipeline(input));
  return { key: strip.stages[strip.current]?.key, building: strip.building === true, path: strip.path };
};

test("a feature whose changes reach no one else reads Building, not Plan or Promotion", () => {
  const strip = pipelineStrip(featurePipeline(facts()));
  assert.equal(strip.building, true);
  assert.equal(strip.stages.find((stage) => stage.key === "plan")?.status, "passed");
  assert.notEqual(strip.stages[strip.current]?.key, "promoted");
});

test("a feature whose changes reach other places waits at Plan until a plan is stored", () => {
  const strip = current(facts({ places: 3 }));
  assert.equal(strip.key, "plan");
  assert.equal(strip.building, false);
});

test("before any facts run a feature reads Building", () => {
  assert.equal(current(facts({ factsRun: undefined, places: null })).building, true);
});

test("a feature Penguin split follows the split stages", () => {
  const strip = current(facts({ split: { state: "expand_first", entries: 3, promotion: null, retiring: 0 } }));
  assert.equal(strip.path, "split");
  assert.equal(strip.key, "expand");
});

test("a landed feature is Promoted and nothing earlier is current", () => {
  const strip = pipelineStrip(featurePipeline(facts({ state: "landed" })));
  assert.equal(strip.stages.at(-1)?.key, "promoted");
});
