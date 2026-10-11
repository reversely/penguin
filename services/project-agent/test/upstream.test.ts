// The choice of assignee for a fix sent upstream (upstream.ts). tests/integration/send-upstream.test.ts
// covers the whole flow on the identity-unification fixture.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CharterIdentity } from "@penguin/issues";

import { upstreamAssignee } from "../src/upstream.ts";
import { fixtureScopeMap } from "./huddle-project.ts";

const scopeMap = fixtureScopeMap();

function identity(handle: string, charterScopes: string[]): CharterIdentity {
  const ownerId = handle.slice(1, handle.indexOf("/"));
  return { handle, ownerId, teamOwners: [], charterScopes, charterPaths: [] };
}

const reports = identity("@jun/reports", ["analytics"]);
const mergeRules = identity("@priya/merge-rules", ["identity-map"]);
const backfill = identity("@priya/backfill", ["identity-map"]);
const docs = identity("@priya/docs", []);
const priyaTrigger = { triggerOwner: "priya", triggerScopes: ["identity-map"] };

test("a running session of the changing scope's owner, chartered for the scope, is preferred", () => {
  const all = [reports, mergeRules, backfill, docs];
  assert.deepEqual(upstreamAssignee(priyaTrigger, reports, scopeMap, all, ["@priya/merge-rules", "@priya/backfill"]), {
    identity: "@priya/merge-rules",
  });
  assert.deepEqual(upstreamAssignee(priyaTrigger, reports, scopeMap, all, ["@priya/docs", "@priya/backfill"]), {
    identity: "@priya/backfill",
  });
});

test("with no chartered session running, the first chartered identity by handle is chosen", () => {
  const all = [reports, mergeRules, backfill, docs];
  assert.deepEqual(upstreamAssignee(priyaTrigger, reports, scopeMap, all, ["@priya/docs"]), {
    identity: "@priya/backfill",
  });
});

test("an owner with no identity chartered for the scope is assigned in person", () => {
  assert.deepEqual(upstreamAssignee(priyaTrigger, reports, scopeMap, [reports, docs], []), { person: "priya" });
});

test("the upstream scopes are the changed scopes outside the sender's charter, and their owner gets the fix", () => {
  // A trigger of Priya's that changed analytics too: the analytics part is the sender's own.
  const wide = { triggerOwner: "priya", triggerScopes: ["analytics", "identity-map"] };
  assert.deepEqual(upstreamAssignee(wide, reports, scopeMap, [reports, mergeRules], []), {
    identity: "@priya/merge-rules",
  });
  // A trigger that changed only another owner's scope sends the fix to that owner.
  const messaging = { triggerOwner: "priya", triggerScopes: ["messaging"] };
  const campaigns = identity("@sam/campaigns", ["messaging"]);
  assert.deepEqual(upstreamAssignee(messaging, reports, scopeMap, [reports, mergeRules, campaigns], []), {
    identity: "@sam/campaigns",
  });
  // A trigger that changed no mapped scope leaves the trigger's owner.
  assert.deepEqual(
    upstreamAssignee({ triggerOwner: "priya", triggerScopes: [] }, reports, scopeMap, [reports, docs], []),
    { identity: "@priya/docs" },
  );
});
