// wait_for_work wakes an idle agent (#210): a waiting session answers as soon as a caller item opens
// on its fork, with only the entries it has not read; with nothing new it answers nothing_yet at its
// timeout, sending a progress notification every round of at most a minute; it waits only on its own
// session's work. The wait holds on the ProjectAgent's WorkSignal, which the same events that update
// get_work move, and reads no storage while it waits. A session that registers in an open feature's
// worktree joins that feature, so its wait carries the feature's caller items (#213).

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseScopeMap } from "@penguin/scope-map";

import { joinWorktreeFeature } from "../../services/project-agent/src/feature-open.ts";
import { FeatureStore } from "../../services/project-agent/src/feature-store.ts";
import { IdentityStore } from "../../services/project-agent/src/identity-store.ts";
import { IssueIndex, type SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { SessionStore } from "../../services/project-agent/src/session-store.ts";
import { WorkSignal } from "../../services/project-agent/src/work-wait.ts";
import { createPenguinMcpServer, type CallerSummaryView, type McpProject } from "../../services/mcp/src/tools.ts";
import { PROGRESS_INTERVAL_MS, type WorkRound } from "../../services/mcp/src/wait-for-work.ts";

const SESSION = "session-jun";

const item = (n: number, feature: string): CallerSummaryView => ({
  item: `caller-${n.toString(16).padStart(16, "0")}`,
  origin: "accounts-merge",
  feature,
  contract: "accounts/shoppers.py::Shopper",
  verdict: "unaffected",
  state: "confirmation_requested",
  waitingOn: "receiving_agent",
  ownerAsked: null,
  yourTurn: { tools: ["confirm_caller", "review_caller"] },
  differingCalls: 0,
});

/** Jun's session on cohort-ltv; `receiving` holds the caller items on each person's worktree. */
function junsProject(round: McpProject["awaitSessionWork"]) {
  const receiving: Record<string, CallerSummaryView[]> = { jun: [item(1, "cohort-ltv")], priya: [] };
  const reads = new Map<string, readonly string[]>();
  const live = (caller: string, sessionId: string) =>
    caller === "jun" && sessionId === SESSION
      ? ({ status: "ok", session: { id: SESSION, identityId: "id-jun", handle: "@jun/cohort-ltv", vendor: "claude-code", worktreeId: "w", branch: "b", status: "running", lastSeen: "" } } as const)
      : ({ status: "rejected", reason: "forbidden", message: `session ${sessionId} is not ${caller}'s` } as const);
  const project: McpProject = {
    registerSession: () => ({ status: "rejected", reason: "invalid", message: "" }),
    sessionHeartbeat: live,
    sessionWork: (caller, sessionId) => (live(caller, sessionId).status === "ok" ? { status: "ok", issueIds: [] } : live(caller, sessionId) as never),
    readIdentity: () => undefined,
    readFixTask: () => undefined,
    threadsNeeding: () => [],
    issueRoutes: () => [],
    readIssue: () => ({ issue: undefined, timeline: [] }),
    sessionUpdate: () => ({ status: "rejected", reason: "invalid", message: "" }),
    reportCheckpoint: () => ({ status: "rejected", reason: "invalid", message: "" }),
    callerWork: (caller) => ({ receiving: receiving[caller] ?? [], originating: [] }),
    awaitSessionWork: (caller, sessionId, since, ms) => (live(caller, sessionId).status === "ok" ? round!(caller, sessionId, since, ms) : (live(caller, sessionId) as WorkRound)),
    workRead: (_caller, sessionId) => reads.get(sessionId) ?? [],
    markWorkRead: (_caller, sessionId, keys) => void reads.set(sessionId, keys),
  };
  return { project, receiving };
}

async function connect(owner: string, project: McpProject) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await createPenguinMcpServer(owner, project, { issues: "issues", base: "base", ownerFork: `owner-${owner}` }).connect(server);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(client);
  return async (name: string, args: Record<string, unknown>, progress: { progress: number }[] = []) => {
    const answer = (await mcp.callTool({ name, arguments: args }, { onprogress: (each) => progress.push(each), timeout: 10_000 })) as { content: { text: string }[]; isError?: boolean };
    return { value: JSON.parse(answer.content[0]?.text ?? "{}") as Record<string, any>, isError: answer.isError === true };
  };
}

test("a waiting session answers as soon as a caller item opens on its fork, with only the new entry", async () => {
  const signal = new WorkSignal();
  const { project, receiving } = junsProject((_caller, _session, since, ms) => signal.wait(since, ms).then((round) => ({ status: "ok", ...round })));
  const call = await connect("jun", project);
  await call("get_work", { sessionId: SESSION });

  const started = Date.now();
  const waiting = call("wait_for_work", { sessionId: SESSION });
  while (signal.waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  receiving["jun"]!.push(item(2, "cohort-ltv"));
  signal.changed();
  const answer = await waiting;

  assert.ok(Date.now() - started < PROGRESS_INTERVAL_MS, "it answers on the change, not at a round's end");
  assert.equal(answer.value["status"], "new_work");
  assert.deepEqual(
    answer.value["callerItems"]["receiving"].map((each: CallerSummaryView) => each.item),
    [item(2, "cohort-ltv").item],
    "only the item opened while it waited",
  );
  assert.equal(answer.value["issues"], undefined, "no list without a new entry");
  assert.equal(signal.waiting, 0, "nothing still waits on the signal");
});

test("with nothing new for its session it answers nothing_yet at its timeout, after a progress notification every round", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  t.after(() => mock.timers.reset());
  const asked: number[] = [];
  let rounds = 0;
  const { project, receiving } = junsProject((_caller, _session, _since, ms) => {
    asked.push(ms);
    mock.timers.tick(ms);
    rounds += 1;
    // Round 2: Priya's worktree gets an item; Jun's wait reads its own work again and keeps waiting.
    if (rounds === 2) receiving["priya"]!.push(item(3, "accounts-merge"));
    return { status: "ok", mark: { epoch: "e", version: rounds >= 2 ? 1 : 0 }, changed: rounds === 1 || rounds === 2 };
  });
  const call = await connect("jun", project);
  await call("get_work", { sessionId: SESSION });

  const progress: { progress: number }[] = [];
  const answer = await call("wait_for_work", { sessionId: SESSION, timeoutSeconds: 300 }, progress);

  assert.deepEqual(answer.value, { status: "nothing_yet" });
  assert.deepEqual(asked, [0, 60_000, 60_000, 60_000, 60_000, 60_000], "a first round at once, then rounds of a minute until the timeout");
  assert.deepEqual(progress.map((each) => each.progress), [0, 1, 2, 3, 4, 5], "one notification at the start and one after each round");
});

test("a session waits only on its own work: another owner's wait on it is refused", async () => {
  const signal = new WorkSignal();
  const { project } = junsProject((_caller, _session, since, ms) => signal.wait(since, ms).then((round) => ({ status: "ok", ...round })));
  const priya = await connect("priya", project);
  const answer = await priya("wait_for_work", { sessionId: SESSION, timeoutSeconds: 1 });
  assert.deepEqual([answer.isError, answer.value["error"]], [true, "forbidden"]);
  assert.equal(signal.waiting, 0);
});

test("the ProjectAgent's signal wakes a wait only when its mark moves, and ends a round at its timer", async () => {
  const signal = new WorkSignal();
  const at = signal.mark;
  assert.deepEqual(await signal.wait(at, 5), { mark: at, changed: false }, "an unchanged mark waits out its round");
  const woken = signal.wait(at, 60_000);
  signal.changed();
  assert.equal((await woken).changed, true, "a change wakes the round at once");
  assert.equal((await signal.wait(at, 60_000)).changed, true, "a mark the signal moved past returns at once");
  assert.equal((await signal.wait({ epoch: "evicted", version: at.version + 1 }, 60_000)).changed, true, "a mark from before an eviction returns at once");
});

/**
 * Jun's @jun/cohort-ltv opened cohort-ltv from worktree wt_cohort-ltv; a later session registers there
 * (#213). `register` registers as the ProjectAgent does, joining the worktree's running feature.
 */
function cohortWorld() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[], transaction: (body) => body() };
  const scopeMap = parseScopeMap({ scopes: [{ id: "reports", name: "Reports", owner: "jun", paths: ["reports/"], contracts: [], test_command: "true", depends_on: [] }] });
  const identities = new IdentityStore(sql);
  for (const [owner, handle] of [["jun", "@jun/cohort-ltv"], ["jun", "@jun/reports"], ["priya", "@priya/cohort-ltv"]] as const) {
    assert.equal(identities.create(owner, { handle, name: handle.slice(1), job: "builds", charterScopes: owner === "jun" ? ["reports"] : [], autoAccept: true }, scopeMap).status, "ok");
  }
  new IssueIndex(sql);
  const sessions = new SessionStore(sql, identities);
  const features = new FeatureStore(sql);
  const at = { worktreeId: "wt_cohort-ltv", branch: "feature-cohort-ltv" };
  const opener = sessions.register("jun", { identity: "@jun/cohort-ltv", vendor: "claude-code", ...at });
  if (opener.status !== "ok") throw new Error(opener.message);
  features.insert("cohort-ltv", "jun", { scopes: ["reports"], paths: [], contracts: [] }, features.draftRecord("cohort-ltv", "open_feature", { identity: "@jun/cohort-ltv" }, {}) as never);
  features.join("cohort-ltv", opener.session.id);
  const register = (owner: string, identity: string) => {
    const outcome = sessions.register(owner, { identity, vendor: "claude-code", ...at });
    return outcome.status === "ok" ? { ...outcome, feature: joinWorktreeFeature(features, owner, outcome.session) } : outcome;
  };
  return { sessions, features, register };
}

test("a session registering in an open feature's worktree joins it, and a caller item opening there wakes its wait", async () => {
  const { sessions, features, register } = cohortWorld();
  const signal = new WorkSignal();
  const receiving: Record<string, CallerSummaryView[]> = { "cohort-ltv": [] };
  const reads = new Map<string, readonly string[]>();
  const project: McpProject = {
    registerSession: (caller, input) => register(caller, input.identity),
    sessionHeartbeat: (caller, sessionId) => sessions.heartbeat(caller, sessionId),
    sessionWork: () => ({ status: "ok", issueIds: [] }),
    readIdentity: () => undefined,
    readFixTask: () => undefined,
    threadsNeeding: () => [],
    issueRoutes: () => [],
    readIssue: () => ({ issue: undefined, timeline: [] }),
    sessionUpdate: () => ({ status: "rejected", reason: "invalid", message: "" }),
    reportCheckpoint: () => ({ status: "rejected", reason: "invalid", message: "" }),
    // As caller-items.ts does: a session sees the items on the feature it works on.
    callerWork: (_caller, sessionId) => {
      const feature = features.featureOfSession(sessionId);
      return feature === undefined ? undefined : { receiving: receiving[feature] ?? [], originating: [] };
    },
    awaitSessionWork: (_caller, _sessionId, since, ms) => signal.wait(since, ms).then((round) => ({ status: "ok", ...round })),
    workRead: (_caller, sessionId) => reads.get(sessionId) ?? [],
    markWorkRead: (_caller, sessionId, keys) => void reads.set(sessionId, keys),
  };
  const call = await connect("jun", project);

  const registered = await call("register_session", { identity: "@jun/cohort-ltv", vendor: "claude-code", worktreeId: "wt_cohort-ltv", branch: "feature-cohort-ltv" });
  const sessionId = registered.value["sessionId"] as string;
  assert.equal(registered.value["feature"], "cohort-ltv", "the answer names the feature it joined");
  assert.equal(features.featureOfSession(sessionId), "cohort-ltv");

  await call("get_work", { sessionId });
  const waiting = call("wait_for_work", { sessionId });
  while (signal.waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  receiving["cohort-ltv"]!.push(item(4, "cohort-ltv"));
  signal.changed();
  const answer = await waiting;
  assert.equal(answer.value["status"], "new_work");
  assert.deepEqual(answer.value["callerItems"]["receiving"].map((each: CallerSummaryView) => each.item), [item(4, "cohort-ltv").item]);
});

test("a registering session joins only a running feature of its own owner and identity", () => {
  const { features, register } = cohortWorld();
  const joined = (outcome: ReturnType<typeof register>) => (outcome.status === "ok" ? outcome.feature : outcome.message);
  assert.equal(joined(register("priya", "@priya/cohort-ltv")), null, "another owner's identity in the same worktree joins nothing");
  assert.equal(joined(register("jun", "@jun/reports")), null, "another identity of the same owner joins nothing");
  features.setState("cohort-ltv", ["opening"], "landed");
  assert.equal(joined(register("jun", "@jun/cohort-ltv")), null, "a landed feature is not joined");
});
