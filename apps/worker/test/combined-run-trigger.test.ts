// The Huddle flow's trigger end to end (#67), without the network: owners' bridges report the
// identity-unification fixture's real checkpoints to the Worker's checkpoint route, the ProjectAgent's
// stores schedule combined runs, and runner mode claims, runs and reports them through the Worker's
// routes. Nobody calls POST /combined-runs except the runner pass.
//
// The Worker's routes run in process (handleRequest), and the bridge's own client functions reach
// them through an injected fetch. The fixture repo stands in for each owner's fork and the base repo.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { generateSigningKeyPair } from "@penguin/issues";
import {
  claimCombinedRuns,
  combinedRunPass,
  forkFetcher,
  localRemote,
  reportCombinedRun,
  SPOOL_VERSION,
  TestRunner,
  type Fetch,
} from "@penguin/local-bridge";

import { handleRequest, type GatewayHandlers } from "../src/gateway.ts";
import { sendCheckpointReport } from "../../../services/local-bridge/src/checkpoint-report.ts";
import { BridgeRegistry } from "../../../services/project-agent/src/bridge-registry.ts";
import { gitHistory, HuddleProject } from "../../../services/project-agent/test/huddle-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const SERVER = "https://penguin.example";
const OPTIONS = { deployerToken: "deployer-secret-for-tests" };

let root: string;
let fixture: string;
let pins: { branches: Record<string, string>; tags: Record<string, string> };

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-combined-trigger-")));
  fixture = join(root, "fixture");
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), fixture]);
  pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as typeof pins;
});

after(() => rm(root, { recursive: true, force: true }));

/** One project behind the Worker's bridge routes, with a bridge per owner and a runner bridge. */
async function deployment(name: string) {
  const project = new HuddleProject();
  const registry = new BridgeRegistry(project.sql);
  const history = gitHistory(fixture);
  /** Every POST /combined-runs the Worker answered, by bridge token. */
  const combinedRunCalls: string[] = [];
  const handlers = {
    bridges: () => ({
      issueBridgeRegistrationCode: (owner: string, role: "owner" | "runner", ttl: number) =>
        registry.issueCode(owner, role, ttl),
      registerBridge: (code: string, key: unknown) => registry.register(code, key),
      authenticateBridge: (token: string) => registry.authenticate(token),
      revokeBridge: (bridgeId: string) => registry.revoke(bridgeId),
      pendingOperations: (caller: { bridgeId: string; role: "owner" | "runner" }) => project.index.pendingFiles(caller),
      // As ProjectAgent.reportBridgeCheckpoint: record, then schedule the combined runs.
      reportBridgeCheckpoint: async (owner: string, sha: string) => (await project.report(owner, sha, history)).checkpoint,
      claimCombinedRuns: (caller: { bridgeId: string; role: "owner" | "runner" }) => project.runs.claim(caller),
    }),
    huddles: () => ({
      open: (event: unknown) => project.open(event),
      recordRepo: async (triggerCommit: string, huddleRepo: string) => project.huddles.setRepo(triggerCommit, huddleRepo),
      forkRepo: async (huddleId: string) => ({ name: `huddle-${huddleId}` }),
    }),
    ownerForkRepo: (owner: string) => `owner-${owner}`,
    projectRepos: { issues: "issues", base: "base" },
    mintToken: () => Promise.reject(new Error("no Artifacts in this test")),
  } as unknown as GatewayHandlers;
  const fetchImpl: Fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/combined-runs") combinedRunCalls.push(request.headers.get("Authorization") ?? "");
    return handleRequest(request, OPTIONS, handlers);
  };

  const tokens = new Map<string, string>();
  for (const [bridge, role] of [["priya", "owner"], ["jun", "owner"], ["sam", "owner"], ["runner", "runner"]] as const) {
    const { code } = await registry.issueCode(bridge === "runner" ? "ci" : bridge, role, 600);
    const publicKey = await crypto.subtle.exportKey("jwk", (await generateSigningKeyPair()).publicKey);
    const outcome = await registry.register(code, publicKey);
    assert.equal(outcome.status, "registered");
    if (outcome.status === "registered") tokens.set(bridge, outcome.bridge.bridgeToken);
  }

  /** The owner's bridge reports a checkpoint it pushed, through the real report function. */
  const publish = async (owner: string, sha: string) => {
    const entry = { v: SPOOL_VERSION, kind: "checkpoint-report" as const, id: `report-${sha}`, queued_at: "", fork: `penguin:owner-${owner}`, sha };
    const result = await sendCheckpointReport(SERVER, tokens.get(owner) as string, entry, fetchImpl);
    assert.deepEqual(result, { status: "reported" });
  };

  // The runner's own repository starts empty and fetches each fork it needs.
  const runnerRepo = join(root, name, "runner");
  await mkdir(runnerRepo, { recursive: true });
  await runGit(runnerRepo, ["init", "--quiet"]);
  const scratch = join(root, name, "scratch");
  await mkdir(scratch);
  const runnerToken = tokens.get("runner") as string;
  const pass = () =>
    combinedRunPass({
      claim: () => claimCombinedRuns(SERVER, runnerToken, fetchImpl),
      report: (event) => reportCombinedRun(SERVER, runnerToken, event, fetchImpl),
      // Every fork is the fixture repo here; the runner fetches it as it fetches a fork.
      fetchForks: forkFetcher(() => localRemote(fixture), runnerRepo),
      repoPath: runnerRepo,
      runner: new TestRunner({ repoPath: runnerRepo, env: TEST_ENV, scratchDir: scratch, consent: () => true }),
    });
  return { project, publish, pass, combinedRunCalls, tokens, fetchImpl };
}

/** Runs `body` with outbound sockets and the global fetch refused, and returns what was attempted. */
async function withoutNetwork<T>(body: () => Promise<T>): Promise<{ value: T; attempts: string[] }> {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    attempts.push(`connect ${JSON.stringify(args[0])}`);
    throw new Error("network access on the combined-run path");
  } as typeof connect;
  globalThis.fetch = (input) => {
    attempts.push(`fetch ${String(input)}`);
    return Promise.reject(new Error("network access on the combined-run path"));
  };
  try {
    return { value: await body(), attempts };
  } finally {
    net.Socket.prototype.connect = connect;
    globalThis.fetch = originalFetch;
  }
}

test("publishing Priya's checkpoint after Jun's and Sam's opens the Huddle with no manual combined-run call", async () => {
  const { value: flow, attempts } = await withoutNetwork(async () => {
    const { project, publish, pass, combinedRunCalls } = await deployment("failing");
    const [priya, jun, sam] = ["priya", "jun", "sam"].map((owner) => pins.tags[`owner-${owner}-checkpoint`] as string);
    await publish("jun", jun as string);
    await publish("sam", sam as string);
    // Analytics and messaging are depended on by no scope, so their checkpoints schedule nothing.
    assert.equal((await pass()).claimed, 0);

    await publish("priya", priya as string);
    assert.deepEqual(
      project.runs.byTrigger("priya", priya as string).map((run) => [run.ownerId, run.commandIds, run.status]),
      [
        ["jun", ["test:analytics"], "scheduled"],
        ["sam", ["test:messaging"], "scheduled"],
      ],
    );
    assert.deepEqual(combinedRunCalls, []);

    const first = await pass();
    assert.equal(first.claimed, 2);
    assert.equal(first.batches.length, 1);
    assert.equal(first.batches[0]?.reply?.status, "opened");
    assert.equal(combinedRunCalls.length, 1);
    assert.deepEqual(project.huddleIssues(), ["1"]);
    assert.deepEqual(
      project.fixes("1").map((fix) => fix.split(" ").slice(0, 2).join(" ")),
      [
        "@jun/retention-dashboard test_identity::shared_device_split",
        "@jun/retention-dashboard test_retention::dau_stable",
        "@sam/reengagement-audience test_consent::unsubscribe_survives",
      ],
    );
    assert.equal(project.index.issue("1")?.state, "fixing");
    assert.deepEqual(
      project.runs.byTrigger("priya", priya as string).map((run) => run.status),
      ["failed", "failed"],
    );

    // Reporting the same checkpoint again schedules nothing, so nothing runs and nothing is written.
    const applied = project.appliedCount();
    await publish("priya", priya as string);
    assert.equal(project.runs.byTrigger("priya", priya as string).length, 2);
    assert.equal((await pass()).claimed, 0);
    assert.equal(project.appliedCount(), applied);
    assert.equal(combinedRunCalls.length, 1);
    return project;
  });
  assert.deepEqual(flow.huddleIssues(), ["1"]);
  // Git and pytest run as child processes; this process opened no connection, so called no model.
  assert.deepEqual(attempts, []);
});

test("a passing combined run records the pass and opens no Huddle", async () => {
  const { project, publish, pass } = await deployment("passing");
  // Each owner's branch head holds their fix, so the merged checkpoints pass.
  const [priya, jun, sam] = ["priya", "jun", "sam"].map((owner) => pins.branches[`owner-${owner}`] as string);
  await publish("jun", jun as string);
  await publish("sam", sam as string);
  await publish("priya", priya as string);

  const result = await pass();
  assert.equal(result.claimed, 2);
  assert.deepEqual(result.batches[0]?.results.map(({ scopeId, status }) => `${scopeId} ${status}`), [
    "analytics passed",
    "messaging passed",
  ]);
  assert.equal(result.batches[0]?.reply?.status, "no_failures");
  assert.deepEqual(project.huddleIssues(), []);
  assert.deepEqual(project.index.ids(), []);
  assert.deepEqual(
    project.runs.byTrigger("priya", priya as string).map((run) => [run.ownerId, run.status]),
    [
      ["jun", "passed"],
      ["sam", "passed"],
    ],
  );
});

test("an owner's bridge cannot claim a scheduled run", async () => {
  const { project, publish, tokens, fetchImpl } = await deployment("owner-claim");
  await publish("jun", pins.tags["owner-jun-checkpoint"] as string);
  await publish("priya", pins.tags["owner-priya-checkpoint"] as string);
  await assert.rejects(claimCombinedRuns(SERVER, tokens.get("priya") as string, fetchImpl), /only to a runner bridge/);
  assert.deepEqual(
    project.runs.byTrigger("priya", pins.tags["owner-priya-checkpoint"] as string).map((run) => run.status),
    ["scheduled"],
  );
});
