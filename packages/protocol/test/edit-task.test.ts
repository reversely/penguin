// Routing edit tasks by charter (#128, PRD 0.5 section 4.4a): builder first, then the scope owner's
// steward, then a person; a task whose places fall under two charters splits.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKGROUND_RUN_CAP_DEFAULT,
  builderHandle,
  checkEditTaskSpec,
  parseBackgroundRunCap,
  parseEditRunMinutes,
  routeEdit,
  stewardHandle,
  type EditCharter,
  type EditRoutingContext,
} from "../src/index.ts";

const scopes: Record<string, { owner: string; prefix: string }> = {
  analytics: { owner: "jun", prefix: "analytics/" },
  messaging: { owner: "sam", prefix: "messaging/" },
  ingestion: { owner: "priya", prefix: "shared/" },
};
const stewards: Record<string, EditCharter> = {
  jun: { handle: "@jun/steward", person: "jun", scopes: ["analytics"], paths: [] },
  sam: { handle: "@sam/steward", person: "sam", scopes: ["messaging"], paths: [] },
};
const builders: Record<string, EditCharter> = {
  // Jun's report declares analytics and one path of Priya's scope.
  "weekly-report": { handle: "@jun/weekly-report", person: "jun", scopes: ["analytics"], paths: ["shared/dates.py"] },
};
const context: EditRoutingContext = {
  scopeOf: (path) => Object.entries(scopes).find(([, scope]) => path.startsWith(scope.prefix))?.[0],
  ownerOf: (scope) => scopes[scope]?.owner,
  builderOf: (feature) => builders[feature],
  stewardOf: (person) => stewards[person],
};
const jun = { kind: "feature", feature: "weekly-report", person: "jun" } as const;

test("an edit in a feature's fork inside its builder's charter goes to the builder", () => {
  assert.deepEqual(routeEdit(jun, [{ path: "analytics/weekly.py" }, { path: "shared/dates.py" }], context, "priya"), [
    { via: "builder", handle: "@jun/weekly-report", person: "jun", paths: ["analytics/weekly.py", "shared/dates.py"], scopes: ["analytics", "ingestion"] },
  ]);
});

test("a place outside the builder's charter goes to the steward of its scope's owner", () => {
  const routes = routeEdit(jun, [{ path: "analytics/weekly.py" }, { path: "messaging/reminders.py" }], context, "priya");
  assert.deepEqual(
    routes.map(({ via, handle, paths }) => ({ via, handle, paths })),
    [
      { via: "builder", handle: "@jun/weekly-report", paths: ["analytics/weekly.py"] },
      { via: "steward", handle: "@sam/steward", paths: ["messaging/reminders.py"] },
    ],
  );
});

test("a review form or an edit on main goes to the steward of the scope's owner", () => {
  assert.deepEqual(routeEdit({ kind: "main" }, [{ scope: "messaging" }], context, "priya"), [
    { via: "steward", handle: "@sam/steward", person: "sam", paths: [], scopes: ["messaging"] },
  ]);
});

test("a place no charter holds asks a person: its scope's owner, else the target's person", () => {
  // Priya has no steward here and Jun's builder does not hold shared/batches.py.
  const routes = routeEdit(jun, [{ path: "shared/batches.py" }, { path: "README.md" }], context, "ines");
  assert.deepEqual(
    routes.map(({ via, handle, person, paths }) => ({ via, handle, person, paths })),
    [
      { via: "person", handle: null, person: "priya", paths: ["shared/batches.py"] },
      { via: "person", handle: null, person: "jun", paths: ["README.md"] },
    ],
  );
  assert.equal(routeEdit({ kind: "main" }, [{ path: "README.md" }], context, "ines")[0]?.person, "ines");
});

test("stewards and builders take predictable handles that fit the handle pattern", () => {
  assert.equal(stewardHandle("jun"), "@jun/steward");
  assert.equal(builderHandle("jun", "retention.dashboard"), "@jun/retention-dashboard");
  assert.equal(builderHandle("jun", "retention-dashboard", 2), "@jun/retention-dashboard-2");
  assert.equal(builderHandle("jun", "steward"), "@jun/steward-feature");
  const long = builderHandle("a".repeat(39), "b".repeat(63), 3);
  assert.ok(long.length <= 80 && /^@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(long), long);
});

test("the cap and the run window parse from the project's settings", () => {
  assert.equal(parseBackgroundRunCap(undefined), BACKGROUND_RUN_CAP_DEFAULT);
  assert.equal(parseBackgroundRunCap("3"), 3);
  assert.equal(parseBackgroundRunCap("0"), undefined);
  assert.equal(parseBackgroundRunCap("9"), undefined);
  assert.equal(parseEditRunMinutes("15"), 15 * 60_000);
  assert.equal(parseEditRunMinutes("61"), undefined);
});

test("a claimed task's spec is checked field by field", () => {
  const spec = {
    taskId: 1,
    kind: "next_step",
    handle: "@jun/weekly-report",
    person: "jun",
    feature: "utc-day",
    fork: "feature-weekly-report",
    branch: "main",
    paths: ["analytics/weekly.py"],
    scopes: ["analytics"],
    allowed: ["analytics", "analytics/weekly.py"],
    instructions: "Adapt.",
    verifier: "The tests check.",
    evidence: [],
    leaseUntil: "2026-10-12T10:00:00.000Z",
    fixWrite: null,
    review: null,
  };
  assert.deepEqual(checkEditTaskSpec(spec), []);
  assert.notDeepEqual(checkEditTaskSpec({ ...spec, fork: "owner-jun" }), []);
  assert.notDeepEqual(checkEditTaskSpec({ ...spec, extra: 1 }), []);
  // A review names the one part revision and scope its form covers.
  const review = { ...spec, kind: "review", review: { feature: "utc-day", scope: "analytics", part: "utc-day/v1#1", revision: 1 } };
  assert.deepEqual(checkEditTaskSpec(review), []);
  assert.notDeepEqual(checkEditTaskSpec({ ...review, review: { ...review.review, revision: 0 } }), []);
  assert.notDeepEqual(checkEditTaskSpec({ ...review, review: { ...review.review, token: "x" } }), []);
});
