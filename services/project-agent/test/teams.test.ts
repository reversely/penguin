// Teams own scopes and routing follows each scope's DRI, then its fallback order (#135, PRD 0.5 core
// concepts, sections 4.4a and 7), on the two-person team fixture in tests/fixtures/team-scopes: Priya
// is DRI for identity-map with Jun as fallback, Jun is DRI for analytics, Sam owns messaging alone and
// Maya leads the team without being a member. Lee is Jun's delegate.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { REVIEW_SCHEMA_VERSION, SIDE_BY_SIDE_COMMAND_ID, SIDE_BY_SIDE_TOOL, type Plan, type PlanPart, type ReviewRecord } from "@penguin/protocol";
import { routeScope } from "@penguin/scope-map";

import { mayReadPartLines } from "../src/dashboard-views.ts";
import { EditRoster } from "../src/edit-roster.ts";
import { EditTaskStore } from "../src/edit-tasks.ts";
import { availability, syncEditWork, type EditWorkDeps } from "../src/edit-work.ts";
import { EMPTY_AREA, FeatureStore } from "../src/feature-store.ts";
import type { FixWriteDeps } from "../src/fix-write.ts";
import { FixGrantStore } from "../src/fix-write.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { InboxStore } from "../src/inbox-store.ts";
import { announcePlan, PlanRouteStore, teamExceptions } from "../src/plan-approval.ts";
import { checkProtectedChanges, ProtectedChangeStore } from "../src/protected-change.ts";
import { affectedPlaces } from "../src/propose-plan.ts";
import { recordReview } from "../src/review-record.ts";
import { ReviewStore } from "../src/review-submit.ts";
import { parseScopeFile } from "../src/scope-file.ts";
import type { Session } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const fixture = new URL("../../../tests/fixtures/team-scopes/penguin/", import.meta.url);
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, fixture)));
const scopeMap = parseScopeFile(bytes("scopes.json"), bytes("teams.json"));
const delegates = new Map([["jun", "lee"]]);

class Project {
  readonly sql = sqlite().sql;
  now = 1_000_000;
  readonly identities = new IdentityStore(this.sql);
  readonly features = new FeatureStore(this.sql, () => this.now);
  readonly roster = new EditRoster(this.sql, this.identities);
  readonly tasks = new EditTaskStore(this.sql, { now: () => this.now });
  readonly routes = new PlanRouteStore(this.sql, () => this.now);
  readonly grants = new FixGrantStore(this.sql, () => this.now);
  readonly inbox = new InboxStore(this.sql, this.identities);
  readonly protectedChanges = new ProtectedChangeStore(this.sql);
  sessions: Session[] = [];

  deps(): EditWorkDeps {
    return {
      tasks: this.tasks,
      roster: this.roster,
      features: this.features,
      routes: this.routes,
      grants: this.grants,
      reviews: () => [],
      scopeMap: async () => scopeMap,
      running: () => this.sessions,
      fix: {} as FixWriteDeps,
      cap: 2,
      leaseMs: 20 * 60_000,
      notify: () => undefined,
    };
  }

  open(id: string, person: string): void {
    const record = { ...this.features.draftRecord(id, "open_feature", { person }, {}), signature: "test" };
    assert.equal(this.features.insert(id, person, EMPTY_AREA, record), true);
    this.features.setRepo(id, `feature-${id}`);
  }

  /** A running session of `handle`: its person can take work. */
  session(handle: string): void {
    this.sessions.push({ id: `ses-${this.sessions.length}`, identityId: "", handle, vendor: "claude-code", worktreeId: "wt", branch: "main", status: "running", currentIssueId: null, lastSeen: "" });
  }

  available(): (person: string) => boolean {
    return availability({ tasks: this.tasks, running: () => this.sessions });
  }
}

const BASE = "a".repeat(40);
const FORK = "b".repeat(40);
const KEYS = "one-profile-key";

/** A runner's record of an identity-map review whose one example differs. */
function reviewRecord(): ReviewRecord {
  const contract = "ingestion/identity_map.py::IdentityMap";
  const differing = [{ name: "two devices", args: {}, main: { status: "returned", value: 1 }, fork: { status: "returned", value: 2 } }] as const;
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    base: BASE,
    fork: FORK,
    scope: "identity-map",
    state: "accepted",
    refusals: [],
    invariants: [],
    storedShapes: null,
    sideBySide: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      tool: SIDE_BY_SIDE_TOOL,
      commandId: SIDE_BY_SIDE_COMMAND_ID,
      base: BASE,
      fork: FORK,
      scope: "identity-map",
      sets: [{ source: "examples", file: "ingestion/examples/ids.json", contract, invariants: [KEYS], inputs: ["two devices"], differing: [...differing], invalid: [], mainMs: 0.4, forkMs: 0.5 }],
      totals: { inputs: 1, differing: 1, invalid: 0 },
      timings: { mainMs: 100, forkMs: 110, totalMs: 220 },
    },
    exceptions: [],
    timings: { impactMs: 0, sideBySideMs: 220, totalMs: 230 },
  } as ReviewRecord;
}

const part = (partId: string, scope: string, owner: string, state: PlanPart["approvalState"] = "pending"): PlanPart =>
  ({ partId, revision: 1, place: { kind: "scope", scope }, owner, scopes: [scope], approvalState: state, diff: { files: [] } }) as unknown as PlanPart;

test("a person's steward is chartered on the scopes they are DRI for, not on those they stand in for", () => {
  const project = new Project();
  project.roster.sync(scopeMap, []);
  assert.deepEqual(project.roster.stewardOf("priya")?.scopes, ["identity-map"]);
  assert.deepEqual(project.roster.stewardOf("jun")?.scopes, ["analytics"]);
  assert.deepEqual(project.roster.stewardOf("sam")?.scopes, ["messaging"]);
  // The lead is DRI for nothing, so Penguin makes no steward for them.
  assert.equal(project.roster.stewardOf("maya"), undefined);
  // The identity store refuses Jun a charter on the scope he is only fallback for.
  const steward = project.identities.byHandle("@jun/steward")!;
  assert.equal(project.identities.edit("jun", steward.id, { charterScopes: ["analytics", "identity-map"] }, scopeMap).status, "rejected");
});

test("availability is a bridge polled within the online window or a running session", () => {
  const project = new Project();
  assert.equal(project.available()("priya"), false);
  project.session("@jun/steward");
  project.tasks.claim("priya", "bridge-priya", 2, 60_000, () => false);
  const available = project.available();
  assert.deepEqual(["priya", "jun", "sam"].map(available), [true, true, false]);
});

test("a review form goes to the DRI's steward, and to the fallback's steward while the DRI is away", async () => {
  const project = new Project();
  project.open("crm-sync", "sam");
  project.routes.set("crm-sync", part("crm-sync/v1#1", "identity-map", "priya"));
  // Priya's bridge is online: her steward takes the form.
  project.tasks.claim("priya", "bridge-priya", 2, 60_000, () => false);
  await syncEditWork(project.deps());
  assert.deepEqual(project.tasks.forFeature("crm-sync").map(({ handle, person, via }) => [handle, person, via]), [["@priya/steward", "priya", "steward"]]);

  // On a project where Priya has no bridge online and no session, Jun's running steward stands in.
  const away = new Project();
  away.open("crm-sync", "sam");
  away.routes.set("crm-sync", part("crm-sync/v1#1", "identity-map", "priya"));
  away.session("@jun/steward");
  await syncEditWork(away.deps());
  assert.deepEqual(away.tasks.forFeature("crm-sync").map(({ handle, person, via, scopes }) => [handle, person, via, scopes]), [["@jun/steward", "jun", "steward", ["identity-map"]]]);

  // Nobody can take it: it stays with the DRI, as before teams.
  const empty = new Project();
  empty.open("crm-sync", "sam");
  empty.routes.set("crm-sync", part("crm-sync/v1#1", "identity-map", "priya"));
  await syncEditWork(empty.deps());
  assert.deepEqual(empty.tasks.forFeature("crm-sync").map(({ handle, person }) => [handle, person]), [["@priya/steward", "priya"]]);
});

test("a protected-path confirmation goes to the DRI, then down the fallback order, never to the change's author", async () => {
  const ownChange = { mergeBase: "b".repeat(40), files: [{ path: "ingestion/identity_map.py", oldHash: "1".repeat(40), newHash: "2".repeat(40) }] };
  const check = async (project: Project, featureId: string, available: (person: string) => boolean) => {
    const deps = { store: project.protectedChanges, inbox: project.inbox, notify: () => undefined, readOwnChange: async () => ownChange, readDiffs: async () => [] };
    return checkProtectedChanges(deps, project.features.get(featureId)!, "c".repeat(40), scopeMap, available);
  };
  const project = new Project();
  project.open("crm-sync", "sam");
  assert.deepEqual(await check(project, "crm-sync", () => true), ["priya"]);
  // Priya goes away: the waiting row stays with her, so a checkpoint never moves it.
  assert.deepEqual(await check(project, "crm-sync", (person) => person === "jun"), ["priya"]);

  const away = new Project();
  away.open("crm-sync", "sam");
  assert.deepEqual(await check(away, "crm-sync", (person) => person === "jun"), ["jun"]);
  assert.deepEqual(away.inbox.items("jun").map((item) => item.reason), ["protected_path"]);

  // Jun's own feature with Priya away: he is never asked about his own change, so it stays with Priya.
  const own = new Project();
  own.open("dau-fix", "jun");
  assert.deepEqual(await check(own, "dau-fix", (person) => person === "jun"), ["priya"]);
  // Priya's own feature touches her own protected path: nobody is asked.
  own.open("ids", "priya");
  assert.deepEqual(await check(own, "ids", () => true), []);
});

test("a plan's protected-path item goes to the fallback while the DRI is away", () => {
  const project = new Project();
  const plan = { featureId: "crm-sync", planId: "crm-sync/v1", parts: [{ ...part("crm-sync/v1#1", "messaging", "sam"), diff: { files: [{ path: "ingestion/identity_map.py" }] } }] } as unknown as Plan;
  announcePlan({ routes: project.routes, inbox: project.inbox, notify: () => undefined }, plan, scopeMap, (person) => person === "jun");
  assert.deepEqual(project.inbox.items("jun").map((item) => item.reason), ["protected_path"]);
  assert.deepEqual(project.inbox.items("priya"), []);
});

test("a review exception goes to the scope's DRI, or the fallback while the DRI is away", async () => {
  const routedTo = async (available: (person: string) => boolean): Promise<string | null> => {
    const reviews = new ReviewStore(sqlite().sql);
    // Jun, the fallback, submitted the form; the side-by-side run differs on a protected invariant.
    const review = reviews.insert({
      featureId: "crm-sync",
      scopeId: "identity-map",
      ownerId: "jun",
      reviewer: "@jun/steward",
      sessionId: "ses_jun",
      forkSha: FORK,
      baseSha: BASE,
      form: { rows: [{ invariant: KEYS, verdict: "holds", evidence: ["ingestion/tests/test_ids.py::test_keys"], storedData: "None" }], riskyInputs: [], storedDataMarker: null },
      invariants: [{ id: KEYS, scopeId: "identity-map", statement: "One person has one profile key", protected: true }],
      state: "pending",
      refusals: [],
    });
    const routed: string[] = [];
    const outcome = await recordReview(
      { reviews, routeToOwner: (owner) => routed.push(owner), personFor: (each) => routeScope(scopeMap, each.scopeId, available) },
      { bridgeId: "br_runner", role: "runner" },
      review.id,
      reviewRecord(),
    );
    assert.equal(outcome.status, "recorded");
    assert.deepEqual(routed, outcome.status === "recorded" && outcome.routedTo !== null ? [outcome.routedTo] : []);
    return outcome.status === "recorded" ? outcome.routedTo : null;
  };
  assert.equal(await routedTo(() => true), "priya");
  assert.equal(await routedTo((person) => person === "jun"), "jun");
});

test("a plan part on a scope waits on its DRI, or on the fallback while the DRI is away", () => {
  const project = new Project();
  const use = { scope: "identity-map", symbol: "ingestion/identity_map.py::IdentityMap", path: "ingestion/x.py", line: 1 };
  const impact = { changes: [], headUses: [use], forks: [] } as unknown as Parameters<typeof affectedPlaces>[0];
  const owners = (available?: (person: string) => boolean) => affectedPlaces(impact, [], scopeMap, project.features, new Map(), available).map((place) => place.owner);
  assert.deepEqual(owners(), ["priya"]);
  assert.deepEqual(owners((person) => person === "jun"), ["jun"]);
  assert.deepEqual(owners(() => false), ["priya"]);
});

test("a part's lines are readable by the feature's person, the DRI and their delegate, and the scope's team", () => {
  const plan = { person: "sam" };
  const onIdentity = { owner: "priya", scopes: ["identity-map"] };
  const onAnalytics = { owner: "jun", scopes: ["analytics"] };
  const read = (part: typeof onIdentity, viewer: string) => mayReadPartLines(plan, part, viewer, delegates, scopeMap);
  assert.deepEqual(["sam", "priya", "jun", "lee", "maya", "nobody"].map((viewer) => read(onIdentity, viewer)), [true, true, true, false, false, false]);
  // Lee is the delegate of analytics' DRI.
  assert.deepEqual(["priya", "jun", "lee", "maya"].map((viewer) => read(onAnalytics, viewer)), [true, true, true, false]);
  // A part routed to the fallback: the DRI still reads it as a member of the team.
  assert.equal(read({ owner: "jun", scopes: ["identity-map"] }, "priya"), true);
  // Without a scope map the rule is the one before teams.
  assert.equal(mayReadPartLines(plan, onIdentity, "jun", delegates, undefined), false);
});

test("the team lead sees every exception in the team's scopes, read-only; a member sees none of it there", () => {
  const project = new Project();
  project.routes.set("crm-sync", part("crm-sync/v1#1", "identity-map", "jun"));
  project.routes.set("crm-sync", part("crm-sync/v1#2", "analytics", "jun", "approved"));
  project.routes.set("crm-sync", part("crm-sync/v1#3", "messaging", "sam"));
  project.inbox.reviewException("jun", "crm-sync", "analytics");
  const deps = {
    routes: project.routes,
    reviews: {} as never,
    items: (person: string) => project.inbox.items(person),
    protectedChanges: () => [],
  };
  const seen = teamExceptions(deps, "maya", scopeMap, delegates);
  assert.deepEqual(
    seen.map(({ kind, team, feature, ref, scopes, waitingOn }) => [kind, team, feature, ref, scopes, waitingOn]),
    [
      ["plan_part", "data-platform", "crm-sync", "crm-sync/v1#1", ["identity-map"], "jun"],
      ["review_exception", "data-platform", "crm-sync", "crm-sync/analytics", ["analytics"], "jun"],
    ],
  );
  assert.deepEqual(teamExceptions(deps, "priya", scopeMap, delegates), [], "a member leads nothing");
  assert.deepEqual(teamExceptions(deps, "sam", scopeMap, delegates), [], "a one-person team's owner already sees their own");
});
