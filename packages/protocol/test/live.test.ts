import assert from "node:assert/strict";
import { test } from "node:test";

import {
  featuresChangedMessage,
  identitiesChangedMessage,
  inboxChangedMessage,
  INDEX_CHANGED,
  indexChangedMessage,
  isFeaturesChanged,
  isIdentitiesChanged,
  isInboxChanged,
  parseIndexChanged,
} from "../src/index.ts";

test("an index-changed message names each changed issue once and parses back", () => {
  const text = indexChangedMessage(["40", "41", "40"]);
  assert.deepEqual(JSON.parse(text), { type: INDEX_CHANGED, issues: ["40", "41"], sessions: [] });
  assert.deepEqual(parseIndexChanged(text), { type: INDEX_CHANGED, issues: ["40", "41"], sessions: [] });
});

test("the message names each identity whose session went online or offline once", () => {
  const text = indexChangedMessage([], ["@jun/reports", "@jun/reports"]);
  assert.deepEqual(parseIndexChanged(text), { type: INDEX_CHANGED, issues: [], sessions: ["@jun/reports"] });
  // A message from an agent that names no sessions still parses.
  assert.deepEqual(parseIndexChanged(JSON.stringify({ type: INDEX_CHANGED, issues: ["40"] })), {
    type: INDEX_CHANGED,
    issues: ["40"],
    sessions: [],
  });
});

test("other frames, such as the Agents SDK's own, parse as no message", () => {
  for (const frame of [
    JSON.stringify({ type: "cf_agent_identity", name: "project", agent: "project-agent" }),
    JSON.stringify({ type: INDEX_CHANGED, issues: [40] }),
    JSON.stringify({ type: INDEX_CHANGED }),
    JSON.stringify({ type: INDEX_CHANGED, issues: [], sessions: [1] }),
    JSON.stringify({ type: INDEX_CHANGED, issues: [], sessions: "@jun/reports" }),
    "not json",
    "null",
    new ArrayBuffer(4),
  ]) {
    assert.equal(parseIndexChanged(frame), undefined, String(frame));
  }
});

test("an inbox-changed message is told apart from an index-changed message and other frames", () => {
  assert.equal(isInboxChanged(inboxChangedMessage()), true);
  assert.equal(parseIndexChanged(inboxChangedMessage()), undefined);
  for (const frame of [indexChangedMessage(["40"]), JSON.stringify({ type: "cf_agent_state" }), "null", "not json", new ArrayBuffer(4)]) {
    assert.equal(isInboxChanged(frame), false, String(frame));
  }
});

test("an identities-changed message is told apart from the other messages and frames", () => {
  assert.equal(isIdentitiesChanged(identitiesChangedMessage()), true);
  assert.equal(isInboxChanged(identitiesChangedMessage()), false);
  assert.equal(parseIndexChanged(identitiesChangedMessage()), undefined);
  for (const frame of [indexChangedMessage(["40"]), inboxChangedMessage(), "null", "not json", new ArrayBuffer(4)]) {
    assert.equal(isIdentitiesChanged(frame), false, String(frame));
  }
});

test("a features-changed message is told apart from the other messages and frames", () => {
  assert.equal(isFeaturesChanged(featuresChangedMessage()), true);
  for (const frame of [indexChangedMessage(["40"]), inboxChangedMessage(), identitiesChangedMessage(), "null", "not json", new ArrayBuffer(4)]) {
    assert.equal(isFeaturesChanged(frame), false, String(frame));
  }
  assert.equal(isInboxChanged(featuresChangedMessage()), false);
  assert.equal(isIdentitiesChanged(featuresChangedMessage()), false);
  assert.equal(parseIndexChanged(featuresChangedMessage()), undefined);
});
