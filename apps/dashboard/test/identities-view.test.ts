import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdentityEntry, IdentityLimits, IdentityScope } from "@penguin/protocol";

import {
  avatarProblem,
  blankForm,
  canEdit,
  fieldProblem,
  handleIsFree,
  isOnline,
  scopeTestCommand,
  tabAfterKey,
  formFor,
  formProblem,
  formRequest,
  handleNameMaxLength,
  lines,
  scopeChoices,
  toBase64,
  withOwners,
} from "../src/identities-view.ts";

const LIMITS: IdentityLimits = {
  nameLength: 80,
  jobLength: 1000,
  rules: 32,
  ruleLength: 1000,
  scopes: 32,
  paths: 64,
  pathLength: 512,
  teamOwners: 16,
  avatarBytes: 65_536,
};

const SCOPES: IdentityScope[] = [
  { id: "identity-map", name: "Ingestion and identity map", ownerId: "priya", testCommand: "python -m pytest ingestion" },
  { id: "analytics", name: "Analytics models", ownerId: "jun", testCommand: "python -m pytest analytics" },
  { id: "messaging", name: "Messaging and CRM sync", ownerId: "sam", testCommand: "python -m pytest messaging" },
];

const reports: IdentityEntry = {
  id: "identity-1",
  handle: "@jun/reports",
  name: "Reports",
  avatar: "data:image/png;base64,iVBORw0KGgo=",
  job: "Build a retention dashboard",
  team: false,
  owners: ["jun"],
  charterScopes: ["analytics"],
  charterPaths: ["analytics/retention"],
  charterRules: ["Never change ingestion code", "Ask before a backfill"],
  autoAccept: true,
  duplicatedFrom: null,
  sessions: [],
  history: [{ issueId: "31", title: "Retention shifts", state: "fixing" }],
  lastCheckpoint: null,
  recentOperations: [],
};

test("only an identity's owners see its edit controls", () => {
  assert.equal(canEdit(reports, "jun"), true);
  assert.equal(canEdit(reports, "priya"), false);
  const team = { ...reports, team: true, owners: ["sam", "jun"] };
  assert.equal(canEdit(team, "sam"), true);
  assert.equal(canEdit(team, "jun"), true);
  assert.equal(canEdit(team, "priya"), false);
});

test("charter scope choices are the scope map's scopes of the identity's owners only", () => {
  assert.deepEqual(scopeChoices(SCOPES, ["jun"]).map((scope) => scope.id), ["analytics"]);
  assert.deepEqual(scopeChoices(SCOPES, ["sam", "jun"]).map((scope) => scope.id), ["analytics", "messaging"]);
  assert.deepEqual(scopeChoices(SCOPES, ["nobody"]), []);
  // Dropping a team owner drops the scopes only that owner held.
  const form = { ...blankForm("jun"), team: true, owners: ["jun", "sam"], charterScopes: ["analytics", "messaging"] };
  assert.deepEqual(withOwners(form, ["jun"], SCOPES).charterScopes, ["analytics"]);
});

test("creating sends every field with the signed-in person's handle", () => {
  const form = {
    ...blankForm("jun"),
    handleName: "reports",
    name: "Reports",
    avatar: { url: "data:image/png;base64,AAAA", mediaType: "image/png", data: "AAAA" },
    job: "Build a retention dashboard",
    charterScopes: ["analytics"],
    paths: "analytics/retention\n\n  analytics/cohorts  \n",
    rules: "Never change ingestion code\nAsk before a backfill",
    autoAccept: true,
  };
  assert.equal(formProblem(form, LIMITS), undefined);
  assert.deepEqual(formRequest(form, "jun"), {
    path: "/api/identities",
    body: {
      handle: "@jun/reports",
      name: "Reports",
      job: "Build a retention dashboard",
      avatar: { mediaType: "image/png", data: "AAAA" },
      charterScopes: ["analytics"],
      charterPaths: ["analytics/retention", "analytics/cohorts"],
      charterRules: ["Never change ingestion code", "Ask before a backfill"],
      autoAccept: true,
    },
  });
  const team = { ...form, avatar: null, team: true, owners: ["jun", "sam"] };
  const body = formRequest(team, "jun").body;
  assert.deepEqual(body["owners"], ["jun", "sam"]);
  assert.equal("avatar" in body, false);
});

test("editing leaves the handle and an unchanged avatar out, and a removed avatar sends null", () => {
  const form = formFor(reports, "edit", "jun", new Set());
  assert.equal(form.handleName, "reports");
  assert.equal(form.paths, "analytics/retention");
  const request = formRequest(form, "jun");
  assert.equal(request.path, "/api/identities/identity-1");
  assert.equal("handle" in request.body, false);
  assert.equal("avatar" in request.body, false);
  assert.deepEqual(request.body["charterRules"], reports.charterRules);
  assert.equal(formRequest({ ...form, avatar: null }, "jun").body["avatar"], null);
});

test("duplicating offers a free handle of the signed-in person and sends only the handle and name", () => {
  const taken = new Set(["@jun/reports", "@jun/reports-copy"]);
  const form = formFor(reports, "duplicate", "jun", taken);
  assert.equal(form.handleName, "reports-copy-2");
  assert.equal(formProblem(form, LIMITS), undefined);
  assert.deepEqual(formRequest(form, "jun"), {
    path: "/api/identities/identity-1/duplicate",
    body: { handle: "@jun/reports-copy-2", name: "Reports" },
  });
});

test("a form problem is one clause naming the fix", () => {
  const ok = { ...blankForm("jun"), handleName: "reports", name: "Reports", job: "Fix" };
  const problems = [
    formProblem({ ...ok, handleName: "Reports" }, LIMITS),
    formProblem({ ...ok, handleName: "a--b" }, LIMITS),
    formProblem({ ...ok, name: "  " }, LIMITS),
    formProblem({ ...ok, job: "" }, LIMITS),
    formProblem({ ...ok, team: true, owners: ["jun"] }, LIMITS),
    formProblem({ ...ok, rules: Array.from({ length: 33 }, (_, i) => `rule ${i}`).join("\n") }, LIMITS),
    formProblem({ ...ok, paths: "x".repeat(513) }, LIMITS),
  ];
  for (const problem of problems) {
    assert.ok(problem !== undefined);
    assert.doesNotMatch(problem, /[,.;]/u, problem);
  }
});

test("lines, avatar checks, base64 and the handle cap", () => {
  assert.deepEqual(lines(" a \n\n b\r\n"), ["a", "b"]);
  assert.equal(avatarProblem({ type: "image/png", size: 65_536 }, LIMITS), undefined);
  assert.ok(avatarProblem({ type: "image/png", size: 65_537 }, LIMITS));
  assert.ok(avatarProblem({ type: "image/svg+xml", size: 10 }, LIMITS));
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.equal(handleNameMaxLength("jun"), 80 - "@jun/".length);
});

test("a field shows its own problem when left, and a free handle is one no identity holds", () => {
  const ok = { ...blankForm("jun"), handleName: "reports", name: "Reports", job: "Fix" };
  assert.equal(fieldProblem(ok, "handle"), undefined);
  assert.ok(fieldProblem({ ...ok, handleName: "Bad" }, "handle"));
  assert.equal(fieldProblem({ ...ok, handleName: "" }, "handle"), "Please enter a handle");
  assert.ok(fieldProblem({ ...ok, name: " " }, "name"));
  assert.ok(fieldProblem({ ...ok, job: "" }, "job"));
  // An edit keeps its handle and a duplicate carries its job over, so neither is checked.
  assert.equal(fieldProblem(formFor(reports, "edit", "jun", new Set()), "handle"), undefined);
  assert.equal(fieldProblem({ ...formFor(reports, "duplicate", "jun", new Set()), job: "" }, "job"), undefined);
  const taken = new Set(["@jun/reports"]);
  assert.equal(handleIsFree(ok, "jun", taken), false);
  assert.equal(handleIsFree({ ...ok, handleName: "cohorts" }, "jun", taken), true);
  assert.equal(handleIsFree({ ...ok, handleName: "Cohorts" }, "jun", taken), false);
  assert.equal(handleIsFree(formFor(reports, "edit", "jun", taken), "jun", taken), false);
});

test("the online dot and a scope's test command", () => {
  assert.equal(isOnline(reports), false);
  const session = {
    id: "s1",
    vendor: "codex",
    branch: "b",
    worktreeId: "wt1",
    status: "offline" as const,
    currentIssueId: null,
    lastSeen: "2026-10-11T09:00:00Z",
  };
  assert.equal(isOnline({ ...reports, sessions: [session] }), false);
  assert.equal(isOnline({ ...reports, sessions: [session, { ...session, id: "s2", status: "running" as const }] }), true);
  assert.equal(scopeTestCommand(SCOPES, "analytics"), "python -m pytest analytics");
  assert.equal(scopeTestCommand(SCOPES, "gone"), undefined);
});

test("arrow, Home and End keys move between the detail's tabs and wrap at the ends", () => {
  assert.equal(tabAfterKey("overview", "ArrowRight"), "charter");
  assert.equal(tabAfterKey("history", "ArrowRight"), "overview");
  assert.equal(tabAfterKey("overview", "ArrowLeft"), "history");
  assert.equal(tabAfterKey("charter", "Home"), "overview");
  assert.equal(tabAfterKey("charter", "End"), "history");
  assert.equal(tabAfterKey("charter", "Enter"), undefined);
});
