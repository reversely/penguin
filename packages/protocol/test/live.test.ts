import assert from "node:assert/strict";
import { test } from "node:test";

import { INDEX_CHANGED, indexChangedMessage, parseIndexChanged } from "../src/index.ts";

test("an index-changed message names each changed issue once and parses back", () => {
  const text = indexChangedMessage(["40", "41", "40"]);
  assert.deepEqual(JSON.parse(text), { type: INDEX_CHANGED, issues: ["40", "41"] });
  assert.deepEqual(parseIndexChanged(text), { type: INDEX_CHANGED, issues: ["40", "41"] });
});

test("other frames, such as the Agents SDK's own, parse as no message", () => {
  for (const frame of [
    JSON.stringify({ type: "cf_agent_identity", name: "project", agent: "project-agent" }),
    JSON.stringify({ type: INDEX_CHANGED, issues: [40] }),
    JSON.stringify({ type: INDEX_CHANGED }),
    "not json",
    "null",
    new ArrayBuffer(4),
  ]) {
    assert.equal(parseIndexChanged(frame), undefined, String(frame));
  }
});
