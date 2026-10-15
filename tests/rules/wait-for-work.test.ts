// wait_for_work wakes an idle agent (#210): a waiting session answers as soon as a caller item opens
// on its fork, with only the entries it has not read; with nothing new it answers nothing_yet at its
// timeout, sending a progress notification every round of at most a minute; it waits only on its own
// session's work. The wait holds on the ProjectAgent's WorkSignal, which the same events that update
// get_work move, and reads no storage while it waits.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

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
