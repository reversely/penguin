// Edit tasks routed to a person's steward or a feature's builder by charter (#128, PRD 0.5 section
// 4.4a): routing per kind, the split across charters, the cap and queue order, delivery to a running
// session, and the fallback to asking the person.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LadderDecision, PlanPart } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { EditRoster } from "../src/edit-roster.ts";
import { EditTaskStore, type EditSource } from "../src/edit-tasks.ts";
import { blockReported, claimEditTasks, deliverEditTasks, holdsFixTask, openEditTask, syncEditWork, type EditWorkDeps } from "../src/edit-work.ts";
import { EMPTY_AREA, FeatureStore, type FeatureArea } from "../src/feature-store.ts";
import { FixGrantStore, type FixWriteDeps } from "../src/fix-write.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { PlanRouteStore } from "../src/plan-approval.ts";
import type { Session } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const scope = (id: string, owner: string, paths: string[]) => ({ id, name: id, owner, paths, test_command: "true", contracts: [], depends_on: [] });
const SCOPES = {
  scopes: [
    scope("analytics", "jun", ["analytics/"]),
    scope("reports", "jun", ["reports/"]),
    scope("messaging", "sam", ["messaging/"]),
    scope("ingestion", "priya", ["ingestion/", "shared/"]),
  ],
};

class Project {
  readonly sql = sqlite().sql;
  now = 1_000_000;
  readonly identities = new IdentityStore(this.sql);
  readonly features = new FeatureStore(this.sql, () => this.now);
  readonly roster = new EditRoster(this.sql, this.identities);
  readonly tasks = new EditTaskStore(this.sql, { now: () => this.now });
  readonly routes = new PlanRouteStore(this.sql, () => this.now);
  readonly grants = new FixGrantStore(this.sql, () => this.now);
  scopeMap: ScopeMap = parseScopeMap(SCOPES);
  sessions: Session[] = [];
  reviews: { featureId: string; scopeId: string; createdAt: string }[] = [];
  notified: string[] = [];
  cap = 2;

  deps(): EditWorkDeps {
    return {
      tasks: this.tasks,
      roster: this.roster,
      features: this.features,
      routes: this.routes,
      grants: this.grants,
      reviews: (featureId) => this.reviews.filter((review) => review.featureId === featureId),
      scopeMap: async () => this.scopeMap,
      running: () => this.sessions.filter((session) => session.status === "running"),
      fix: {} as FixWriteDeps,
      cap: this.cap,
      leaseMs: 20 * 60_000,
      notify: (person) => this.notified.push(person),
    };
  }

  open(id: string, person: string, area: Partial<FeatureArea>): void {
    const record = { ...this.features.draftRecord(id, "open_feature", { person }, {}), signature: "test" };
    assert.equal(this.features.insert(id, person, { ...EMPTY_AREA, ...area }, record), true);
    this.features.setRepo(id, `feature-${id}`);
    this.roster.builder(this.features.get(id)!, this.scopeMap);
  }

  session(id: string, handle: string, feature?: string): Session {
    const session: Session = { id, identityId: "", handle, vendor: "claude-code", worktreeId: `wt-${id}`, branch: "main", status: "running", currentIssueId: null, lastSeen: "" };
    this.sessions.push(session);
    if (feature !== undefined) this.features.join(feature, id);
    return session;
  }

  /** The person's bridge polls once: it is online. It claims what fits under the cap. */
  poll(person: string) {
    return this.tasks.claim(person, `bridge-${person}`, this.cap, 20 * 60_000, () => false);
  }

  migration(key: string, target: string, person: string, paths: string[]): EditSource {
    return { key, kind: "migration", feature: "money-type", target, targetPerson: person, places: paths.map((path) => ({ path })), instructions: "Move the callers.", verifier: "The block check.", ref: {} };
  }
}

const decision = (target: string, step: 4 | 5, paths: string[], check: LadderDecision["check"] = "tests"): LadderDecision => ({
  target,
  check,
  failure: "behaviour",
  step,
  nextStep: step === 4 ? "The originating agent adapts, with the failing check and the changed lines attached" : "The agent of the scope's owner adapts",
  actor: { kind: step === 4 ? "originating-agent" : "owner-agent", id: "@x/y" },
  fix: null,
  reason: `${check} failed`,
  evidence: { summary: `1 ${check} failure`, findings: paths.map((path) => ({ path, line: 3, code: null, message: "assert failed" })) },
});

const part = (partId: string, place: PlanPart["place"], owner: string, scopes: string[], state: PlanPart["approvalState"]): PlanPart =>
  ({ partId, revision: 1, place, owner, scopes, approvalState: state }) as unknown as PlanPart;

test("each scope owner gets one steward chartered on every scope they own and on nothing else", () => {
  const project = new Project();
  project.roster.sync(project.scopeMap, []);
  assert.deepEqual(project.roster.stewardOf("jun"), { handle: "@jun/steward", person: "jun", scopes: ["analytics", "reports"], paths: [] });
  assert.deepEqual(project.roster.stewardOf("sam")?.scopes, ["messaging"]);
  // The reports scope moves to Sam: Jun's steward loses it at the next sync and Sam's gains it.
  project.scopeMap = parseScopeMap({ scopes: SCOPES.scopes.map((each) => (each.id === "reports" ? { ...each, owner: "sam" } : each)) });
  project.roster.sync(project.scopeMap, []);
  assert.deepEqual(project.roster.stewardOf("jun")?.scopes, ["analytics"]);
  assert.deepEqual(project.roster.stewardOf("sam")?.scopes, ["messaging", "reports"]);
  // The identity store refuses a charter scope its owner does not own, so a steward never holds one.
  const steward = project.identities.byHandle("@jun/steward")!;
  const refused = project.identities.edit("jun", steward.id, { charterScopes: ["analytics", "messaging"] }, project.scopeMap);
  assert.equal(refused.status, "rejected");
  // Syncing again creates no second steward.
  project.roster.sync(project.scopeMap, []);
  assert.equal(project.identities.list().filter((identity) => identity.handle.endsWith("/steward")).length, 3);
});

test("a feature's builder is chartered on its declared area: the person's scopes and the paths of the rest", () => {
  const project = new Project();
  project.open("weekly-report", "jun", { scopes: ["analytics", "ingestion"], paths: ["analytics/weekly.py"] });
  assert.deepEqual(project.roster.builderOf("jun", "weekly-report"), {
    handle: "@jun/weekly-report",
    person: "jun",
    scopes: ["analytics"],
    paths: ["analytics/weekly.py", "ingestion", "shared"],
  });
});

test("the person's own identity under the feature's builder handle becomes its builder, with no -2 identity", () => {
  const project = new Project();
  const own = project.identities.create("jun", { handle: "@jun/weekly-report", name: "weekly", job: "Builds the weekly report", charterScopes: ["reports"], autoAccept: true }, project.scopeMap);
  assert.equal(own.status, "ok");
  project.open("weekly-report", "jun", { scopes: ["analytics"] });
  // The roster takes it and brings its charter to the feature's area.
  assert.deepEqual(project.roster.builderOf("jun", "weekly-report"), { handle: "@jun/weekly-report", person: "jun", scopes: ["analytics"], paths: [] });
  assert.equal(own.status === "ok" && project.roster.roleOf(own.identity.id)?.role, "builder");
  assert.equal(project.identities.byHandle("@jun/weekly-report-2"), undefined);
  // The area grows: the same identity follows it.
  project.features.setArea("weekly-report", { ...EMPTY_AREA, scopes: ["analytics", "reports"] }, { ...project.features.draftRecord("weekly-report", "declare_area", { person: "jun" }, {}), signature: "test" }, null);
  project.roster.builder(project.features.get("weekly-report")!, project.scopeMap);
  assert.deepEqual(project.roster.builderOf("jun", "weekly-report")?.scopes, ["analytics", "reports"]);
  assert.equal(project.identities.list().filter((identity) => identity.handle.startsWith("@jun/weekly-report")).length, 1);
});

test("an identity under a feature's builder handle that is not the person's own is never taken as its builder", () => {
  const project = new Project();
  // A team identity Jun made with Sam: Jun is one of its owners, not its one owner.
  const team = project.identities.createTeam("jun", { handle: "@jun/weekly-report", name: "weekly", job: "Team work", charterScopes: [], owners: ["jun", "sam"], autoAccept: true }, project.scopeMap);
  assert.equal(team.status, "ok");
  project.open("weekly-report", "jun", { scopes: ["analytics"] });
  assert.deepEqual(project.roster.builderOf("jun", "weekly-report"), { handle: "@jun/weekly-report-2", person: "jun", scopes: ["analytics"], paths: [] });
  assert.equal(team.status === "ok" && project.roster.roleOf(team.identity.id), undefined);
});

test("a failed block run's agent steps become next-step tasks, split across charters under one block", async () => {
  const project = new Project();
  project.open("utc-day", "priya", { scopes: ["ingestion"] });
  project.open("weekly-report", "jun", { scopes: ["analytics"] });
  const run = { runId: "utc-day/1", checkpoint: "c".repeat(40), passed: false };
  await blockReported(project.deps(), "utc-day", run, [
    decision("weekly-report", 5, ["analytics/weekly.py", "messaging/reminders.py"]),
    decision("main", 4, ["shared/dates.py"], "typecheck"),
    // Penguin's own steps and a person's open no task.
    { ...decision("weekly-report", 5, []), step: 6, check: "lint" },
  ]);
  const open = project.tasks.forFeature("utc-day");
  assert.deepEqual(
    open.map(({ kind, target, handle, via, files, sourceKey }) => ({ kind, target, handle, via, files, sourceKey })),
    [
      { kind: "next_step", target: "weekly-report", handle: "@jun/weekly-report", via: "builder", files: ["analytics/weekly.py"], sourceKey: "next:utc-day:weekly-report:tests" },
      { kind: "next_step", target: "weekly-report", handle: "@sam/steward", via: "steward", files: ["messaging/reminders.py"], sourceKey: "next:utc-day:weekly-report:tests" },
      { kind: "next_step", target: "utc-day", handle: "@priya/utc-day", via: "builder", files: ["shared/dates.py"], sourceKey: "next:utc-day:main:typecheck" },
    ],
  );
  assert.match(open[0]!.instructions, /merged onto feature weekly-report's fork/u);
  assert.deepEqual(open[0]!.evidence, ["1 tests failure", "analytics/weekly.py:3 assert failed", "messaging/reminders.py:3 assert failed"]);
  // The same failure reported again is not routed again; a passing run does every open next step.
  await blockReported(project.deps(), "utc-day", { ...run, runId: "utc-day/2" }, [decision("weekly-report", 5, ["analytics/weekly.py"])]);
  assert.equal(project.tasks.forFeature("utc-day").filter((task) => task.state !== "done" && task.state !== "dropped").length, 2);
  await blockReported(project.deps(), "utc-day", { ...run, runId: "utc-day/3", passed: true }, []);
  assert.deepEqual(new Set(project.tasks.forFeature("utc-day").map((task) => task.state)), new Set(["done", "dropped"]));
});

test("a plan part waiting on its owner asks one review form per scope, from the steward of each scope's owner", async () => {
  const project = new Project();
  project.open("utc-day", "priya", { scopes: ["ingestion"] });
  project.routes.set("utc-day", part("utc-day/v1#1", { kind: "scope", scope: "analytics" } as PlanPart["place"], "jun", ["analytics", "reports"], "pending"));
  await syncEditWork(project.deps());
  const reviews = project.tasks.forFeature("utc-day");
  assert.deepEqual(
    reviews.map(({ kind, handle, scopes, state, askReason }) => ({ kind, handle, scopes, state, askReason })),
    [
      // A review form waits for a session or the bridge like any task (#138): with neither, Jun is asked.
      { kind: "review", handle: "@jun/steward", scopes: ["analytics"], state: "asked", askReason: "bridge_offline" },
      { kind: "review", handle: "@jun/steward", scopes: ["reports"], state: "asked", askReason: "bridge_offline" },
    ],
  );
  // Jun starts the steward: its session takes both forms at its next safe checkpoint.
  const steward = project.session("ses-1", "@jun/steward");
  await syncEditWork(project.deps());
  assert.deepEqual(deliverEditTasks(project.deps(), steward).map((task) => task.scopes[0]), ["analytics", "reports"]);
  // The form for analytics arrives: that task is done. The part's approval drops the other.
  project.now += 1_000;
  project.reviews.push({ featureId: "utc-day", scopeId: "analytics", createdAt: new Date(project.now).toISOString() });
  await syncEditWork(project.deps());
  project.routes.set("utc-day", part("utc-day/v1#1", { kind: "scope", scope: "analytics" } as PlanPart["place"], "jun", ["analytics", "reports"], "approved"));
  await syncEditWork(project.deps());
  assert.deepEqual(project.tasks.forFeature("utc-day").map((task) => [task.scopes[0], task.state]), [["analytics", "done"], ["reports", "dropped"]]);
});

test("an approved fix for a running feature routes whole to that feature's builder and is done once written", async () => {
  const project = new Project();
  project.open("utc-day", "priya", { scopes: ["ingestion"] });
  project.open("weekly-report", "jun", { scopes: ["analytics"] });
  const fix = part("utc-day/v1#1", { kind: "feature", feature: "weekly-report" }, "jun", ["analytics", "messaging"], "approved");
  project.routes.set("utc-day", fix);
  // A mechanical part's write is the check runner's: it asks for no task.
  project.routes.set("utc-day", part("utc-day/v1#2", { kind: "feature", feature: "weekly-report" }, "jun", ["analytics"], "approved"));
  project.grants.open("utc-day", "utc-day/v1", part("utc-day/v1#2", { kind: "feature", feature: "weekly-report" }, "jun", [], "approved"), "weekly-report", "runner");
  await syncEditWork(project.deps());
  const [task, ...rest] = project.tasks.forFeature("utc-day");
  assert.equal(rest.length, 0);
  assert.deepEqual([task?.kind, task?.handle, task?.target, task?.ref], ["fix", "@jun/weekly-report", "weekly-report", { part: "utc-day/v1#1", revision: 1 }]);
  // Delivered to the builder's session, that session may write it with fix_token.
  const builder = project.session("ses-2", "@jun/weekly-report", "weekly-report");
  await syncEditWork(project.deps());
  deliverEditTasks(project.deps(), builder);
  assert.equal(holdsFixTask(project.tasks, "ses-2", "utc-day/v1#1", 1), true);
  assert.equal(holdsFixTask(project.tasks, "ses-2", "utc-day/v1#1", 2), false);
  const grant = project.grants.open("utc-day", "utc-day/v1", fix, "weekly-report", "agent");
  project.grants.written(grant.id, "d".repeat(40), "rec-1");
  await syncEditWork(project.deps());
  assert.deepEqual([project.tasks.get(task!.id)?.state, project.tasks.get(task!.id)?.commit], ["done", "d".repeat(40)]);
});

test("a fix whose write waits for its fork's turn stays queued and takes no background run", async () => {
  const project = new Project();
  project.open("utc-day", "priya", { scopes: ["ingestion"] });
  project.open("local-day", "priya", { scopes: ["ingestion"] });
  project.open("weekly-report", "jun", { scopes: ["analytics"] });
  const first = part("utc-day/v1#1", { kind: "feature", feature: "weekly-report" }, "jun", ["analytics"], "approved");
  const second = part("local-day/v1#1", { kind: "feature", feature: "weekly-report" }, "jun", ["analytics"], "approved");
  project.routes.set("utc-day", first);
  project.routes.set("local-day", second);
  // Both writes open at approval, in that order; the first is written, so the second is tried again on the new head.
  const written = project.grants.open("utc-day", "utc-day/v1", first, "weekly-report", "agent");
  const waiting = project.grants.open("local-day", "local-day/v1", second, "weekly-report", "agent");
  project.grants.written(written.id, "d".repeat(40), "rec-1");
  project.grants.retrial(waiting.id, "d".repeat(40), 7);
  await syncEditWork(project.deps());
  // The claim reads each open write's part from its plan: the second part still stands approved.
  const approved = { ...second, approvedBy: "jun", diff: { source: "patch", patch: "", base: "b".repeat(40), files: [] } } as unknown as PlanPart;
  const fix = { features: project.features, grants: project.grants, keeper: () => ({ latestPlan: async () => ({ planId: "local-day/v1", parts: [approved] }) }) } as unknown as FixWriteDeps;
  const claim = await claimEditTasks({ ...project.deps(), fix }, "jun", "bridge-jun");
  assert.deepEqual(claim.status === "ok" ? claim.tasks : null, []);
  assert.equal(project.grants.get("local-day/v1#1", 1)?.state, "queued");
  // The bridge is online, so the task waits in its queue.
  await syncEditWork(project.deps());
  const [task] = project.tasks.forFeature("local-day");
  assert.deepEqual([task?.kind, task?.state], ["fix", "queued"]);
  // Its trial passed on that head: the write's turn has come.
  project.grants.trialled(waiting.id, "d".repeat(40));
  assert.equal(project.grants.waitsFor(project.grants.get("local-day/v1#1", 1)!), null);
});

test("a migration part opened from outside routes by charter like any edit", async () => {
  const project = new Project();
  project.open("basket-size", "jun", { scopes: ["analytics"] });
  const opened = await openEditTask(project.deps(), project.migration("migrate:money-type:jun", "basket-size", "jun", ["analytics/basket.py", "reports/totals.py"]));
  // Reports is Jun's scope but outside the builder's declared area: Jun's steward takes it.
  assert.deepEqual(opened.map((task) => [task.handle, task.files]), [["@jun/basket-size", ["analytics/basket.py"]], ["@jun/steward", ["reports/totals.py"]]]);
  assert.deepEqual(project.notified, ["jun"]);
});

test("a person's bridge holds two background runs by default; the rest queue, oldest first", async () => {
  const project = new Project();
  project.open("basket-size", "jun", { scopes: ["analytics"] });
  for (const n of [1, 2, 3, 4]) await openEditTask(project.deps(), project.migration(`migrate:${n}`, "basket-size", "jun", [`analytics/${n}.py`]));
  const first = project.poll("jun");
  assert.deepEqual(first.map((task) => task.sourceKey), ["migrate:1", "migrate:2"]);
  assert.deepEqual(project.tasks.queue("jun", 2), { running: 2, queued: 2, asked: 0, cap: 2 });
  // The builder took every task, so the steward's own queue the team page shows is empty (#136).
  assert.deepEqual(project.tasks.queue("jun", 2, "builder"), { running: 2, queued: 2, asked: 0, cap: 2 });
  assert.deepEqual(project.tasks.queue("jun", 2, "steward"), { running: 0, queued: 0, asked: 0, cap: 2 });
  assert.deepEqual(project.poll("jun"), []);
  const done = project.tasks.report("bridge-jun", first[0]!.id, { status: "done", outcome: "claude -p changed 1 file", commit: "e".repeat(40) });
  assert.equal(done.status, "ok");
  assert.deepEqual(project.poll("jun").map((task) => task.sourceKey), ["migrate:3"]);
  // Another bridge cannot report a run it did not claim.
  assert.equal(project.tasks.report("bridge-sam", first[1]!.id, { status: "failed", outcome: "x" }).status, "rejected");
});

test("with no session and the bridge offline the person is asked; the bridge polling again takes the task back", async () => {
  const project = new Project();
  project.open("basket-size", "jun", { scopes: ["analytics"] });
  const [task] = await openEditTask(project.deps(), project.migration("migrate:1", "basket-size", "jun", ["analytics/1.py"]));
  await syncEditWork(project.deps());
  assert.deepEqual([project.tasks.get(task!.id)?.state, project.tasks.get(task!.id)?.askReason], ["asked", "bridge_offline"]);
  assert.deepEqual(project.poll("jun").map((each) => each.id), [task!.id]);
  // The bridge stops reporting mid-run: the lease runs out and Jun is asked.
  project.now += 21 * 60_000;
  await syncEditWork(project.deps());
  assert.deepEqual([project.tasks.get(task!.id)?.state, project.tasks.get(task!.id)?.askReason], ["asked", "lease_expired"]);
  assert.deepEqual(project.poll("jun"), []);
});

test("a failed or timed-out run releases the task to its person and the bridge does not take it again", async () => {
  const project = new Project();
  project.open("basket-size", "jun", { scopes: ["analytics"] });
  for (const n of [1, 2]) await openEditTask(project.deps(), project.migration(`migrate:${n}`, "basket-size", "jun", [`analytics/${n}.py`]));
  const [failed, timedOut] = project.poll("jun");
  project.tasks.report("bridge-jun", failed!.id, { status: "failed", outcome: "claude -p exited 1" });
  project.tasks.report("bridge-jun", timedOut!.id, { status: "timeout", outcome: "claude -p ran past 15 minutes" });
  await syncEditWork(project.deps());
  assert.deepEqual(
    project.tasks.forFeature("basket-size").map((task) => [task.state, task.askReason, task.outcome]),
    [["asked", "run_failed", "claude -p exited 1"], ["asked", "run_timeout", "claude -p ran past 15 minutes"]],
  );
  assert.deepEqual(project.poll("jun"), []);
  // A session Jun starts on the feature takes both at its next safe checkpoint.
  const session = project.session("ses-3", "@jun/reports", "basket-size");
  assert.equal(deliverEditTasks(project.deps(), session).length, 2);
  // A report with a malformed commit is refused.
  assert.equal(project.tasks.report("bridge-jun", failed!.id, { status: "done", outcome: "ok", commit: "nope" }).status, "rejected");
});

test("a running session of the identity takes the task at its next safe checkpoint; the bridge leaves it", async () => {
  const project = new Project();
  project.open("basket-size", "jun", { scopes: ["analytics"] });
  const session = project.session("ses-4", "@jun/basket-size", "basket-size");
  const [task] = await openEditTask(project.deps(), project.migration("migrate:1", "basket-size", "jun", ["analytics/1.py"]));
  await syncEditWork(project.deps());
  assert.equal(project.tasks.get(task!.id)?.state, "queued");
  assert.deepEqual(project.tasks.claim("jun", "bridge-jun", 2, 60_000, (each) => each.handle === "@jun/basket-size"), []);
  assert.deepEqual(deliverEditTasks(project.deps(), session).map((each) => each.id), [task!.id]);
  // The session stops: the task waits again, now for the bridge.
  (session as { status: string }).status = "offline";
  project.poll("jun");
  await syncEditWork(project.deps());
  assert.equal(project.tasks.get(task!.id)?.state, "queued");
});
