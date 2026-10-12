// Who sees a colleague's feature as a banner and when it clears, what a colleague's change page asks
// of its viewer, and how the viewer's parts group by scope, file and symbol (banner-view.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OverlapRequest, PlanInbox, PlanPartRequest, PlanPartView, TeamView } from "@penguin/protocol";

import { changePath, colleagueBanners, viewerToDos, yourChanges, yourReaders } from "../src/banner-view.ts";

function request(partId: string, owner: string, ask: PlanPartRequest["ask"], state: PlanPartRequest["state"], feature = "person-id-merge-rules", person = "priya"): PlanPartRequest {
  return {
    ask,
    feature,
    person,
    partId,
    revision: 1,
    place: { kind: "scope", scope: "analytics" },
    owner,
    kind: "behavioural",
    kindReason: "",
    state,
    approvedBy: state === "approved" ? "penguin" : null,
    changeRequests: 0,
    roundLimit: 3,
    files: [],
    breaks: [],
    reviews: [],
    routing: { inPerson: true, reasons: [] },
    changeRequest: null,
    read: false,
    raisedAt: "2026-10-12T09:00:00.000Z",
  };
}

const plan = (parts: PlanPartRequest[], extra: Partial<PlanInbox> = {}): PlanInbox => ({ parts, protectedChanges: [], reviewExceptions: [], returnedPlans: [], ...extra });

const team = (states: Record<string, "building" | "promoted">): TeamView => ({
  people: [
    {
      id: "priya",
      role: { scopes: [], dependents: [], dependencies: [] },
      features: Object.entries(states).map(([id, state]) => ({ id, person: "priya", state, strip: { path: "plan", current: 0, stages: [] }, exceptions: [], agents: [], openedAt: "" })),
      idleAgents: [],
    },
  ],
});

test("a colleague's feature shows one banner while the person has an item of it, marked when it needs them", () => {
  const parts = [request("person-id-merge-rules/v1#1", "jun", "approve", "pending"), request("person-id-merge-rules/v1#3", "jun", "approve", "pending")];
  const banners = colleagueBanners({ overlaps: [], plan: plan(parts) }, team({ "person-id-merge-rules": "building" }), "jun");
  assert.deepEqual(banners, [{ feature: "person-id-merge-rules", person: "priya", needsYou: true, path: "/features/person-id-merge-rules#part-1" }]);
  // A part Penguin approved for Sam keeps a banner that asks nothing, until the block reaches main.
  const sam = colleagueBanners({ overlaps: [], plan: plan([request("person-id-merge-rules/v1#2", "sam", "penguin_approved", "approved")]) }, team({ "person-id-merge-rules": "building" }), "sam");
  assert.deepEqual(sam, [{ feature: "person-id-merge-rules", person: "priya", needsYou: false, path: "/features/person-id-merge-rules#part-2" }]);
  assert.deepEqual(colleagueBanners({ overlaps: [], plan: plan([request("person-id-merge-rules/v1#2", "sam", "penguin_approved", "approved")]) }, team({ "person-id-merge-rules": "promoted" }), "sam"), []);
});

test("a banner clears once the person has nothing left, and the person's own feature never shows one", () => {
  assert.deepEqual(colleagueBanners({ overlaps: [], plan: plan([]) }, team({}), "jun"), []);
  const own = colleagueBanners({ overlaps: [], plan: plan([request("person-id-merge-rules/v1#9", "priya", "round_limit", "round_limit")]) }, undefined, "priya");
  assert.deepEqual(own, []);
});

test("a protected-path confirmation and an overlapping start each need the person", () => {
  const overlap: OverlapRequest = {
    feature: "basket-size",
    blockedFeature: "money-minor-units",
    blockedPerson: "ines",
    overlap: { scopes: ["analytics"], paths: [], contracts: [], omittedPaths: 0 },
    read: true,
    raisedAt: "",
  };
  const banners = colleagueBanners(
    {
      overlaps: [overlap],
      plan: plan([request("money-tax/v1#1", "rahul", "penguin_approved", "approved", "money-tax", "ines")], {
        protectedChanges: [{ feature: "money-analytics", person: "ines", owner: "jun", checkpoint: "a".repeat(40), mergeBase: "b".repeat(40), state: "pending", confirmedBy: null, files: [], read: false, raisedAt: "" }],
      }),
    },
    undefined,
    "jun",
  );
  assert.deepEqual(
    banners.map((banner) => [banner.feature, banner.needsYou, banner.path]),
    [
      ["money-analytics", true, "/features/money-analytics#changes"],
      ["money-minor-units", true, "/features/money-minor-units"],
      ["money-tax", false, "/features/money-tax#part-1"],
    ],
  );
  assert.equal(changePath("a b", "part-1"), "/features/a%20b#part-1");
});

function part(partId: string, owner: string, scope: string, files: PlanPartView["files"], state: PlanPartView["state"] = "pending"): PlanPartView {
  return {
    partId,
    revision: 1,
    place: { kind: "scope", scope },
    owner,
    scopes: [scope],
    kind: "behavioural",
    kindReason: "",
    state,
    approvedBy: null,
    changeRequests: 0,
    changeRequest: null,
    callers: [
      { path: "analytics/models.py", line: 6, kind: "import", symbol: "ingestion.identity_map.IdentityMap", name: "IdentityMap", scope },
      { path: "analytics/models.py", line: 15, kind: "call", symbol: "ingestion.identity_map.IdentityMap.resolve", name: "resolve", scope },
      { path: "analytics/models.py", line: 18, kind: "call", symbol: "ingestion.identity_map.IdentityMap.resolve", name: "resolve", scope },
    ] as unknown as PlanPartView["callers"],
    breaks: [],
    invariants: [],
    note: null,
    files,
  };
}

test("the viewer's parts group by scope then file, each file naming the changed symbols its lines use", () => {
  const file = (path: string) => ({ path, scope: "analytics", status: "modified" as const, hunks: [], omitted: null, omittedLines: 0, added: 0, removed: 0 });
  const page = {
    plan: {
      parts: [part("p/v1#1", "jun", "analytics", [file("analytics/models.py"), file("analytics/tests/test_dau.py")]), part("p/v1#2", "sam", "messaging", null), part("p/v1#3", "jun", "analytics", [file("analytics/report.py")])],
    },
  } as never;
  const groups = yourChanges(page, "jun");
  assert.deepEqual(
    groups.map((group) => [group.scope, group.parts.map((each) => [each.part.partId, each.files.map((one) => [one.anchor, one.file.path, one.symbols.join(" ")])])]),
    [
      [
        "analytics",
        [
          [
            "p/v1#1",
            [
              ["part-1-file-1", "analytics/models.py", "ingestion.identity_map.IdentityMap ingestion.identity_map.IdentityMap.resolve"],
              ["part-1-file-2", "analytics/tests/test_dau.py", ""],
            ],
          ],
          ["p/v1#3", [["part-3-file-1", "analytics/report.py", ""]]],
        ],
      ],
    ],
  );
  // Sam sees Sam's part only; the server left its lines out of Jun's answer, never the other way.
  assert.deepEqual(yourChanges(page, "sam").map((group) => [group.scope, group.parts[0]?.files.length]), [["messaging", 0]]);
  assert.deepEqual(yourChanges(page, "rahul"), []);
});

test("a colleague's change page asks the viewer to decide their parts, confirm their lines and approve a start", () => {
  const page = {
    feature: { person: "priya" },
    plan: { parts: [part("p/v1#1", "jun", "analytics", null), part("p/v1#2", "jun", "analytics", null, "approved"), part("p/v1#3", "sam", "messaging", null)] },
    pipeline: { stages: [{ key: "promoted", status: "person", jobs: [{ key: "protected:jun", status: "person", fact: { kind: "protected", owner: "jun", state: "pending" } }] }] },
    waitingOn: [{ feature: "retention-dashboard", person: "jun", state: "open", approvedBy: null, overlap: { scopes: [], paths: [], contracts: [] } }],
  } as never;
  assert.deepEqual(
    viewerToDos(page, "jun").map((todo) => todo.text),
    ["Decide #1 analytics", "Confirm your protected lines", "Approve its start beside retention-dashboard"],
  );
  assert.deepEqual(viewerToDos(page, "priya"), []);
  for (const todo of viewerToDos(page, "jun")) assert.doesNotMatch(todo.text, /[,.]/u);
  const readers = yourReaders({ dependents: [{ feature: "basket-size", person: "jun", consumerScope: "analytics", providerScope: "money" }, { feature: "basket-size", person: "jun", consumerScope: "analytics", providerScope: "money" }, { feature: "tax-exempt", person: "rahul", consumerScope: "tax", providerScope: "money" }] }, "jun");
  assert.deepEqual(readers.map((reader) => reader.feature), ["basket-size"]);
});
