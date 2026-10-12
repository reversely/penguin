// The Worker's part trial routes (PRD 0.5 sections 4.3 and 6): only a runner bridge claims trials and
// reports them, through the bridge client runner mode uses, and a report is kept against its part
// revision once. The trial's own checks are in services/project-agent/test/part-trial.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { claimPartTrials as claimOver, RemoteRefusedError, reportPartTrial, type Fetch } from "@penguin/local-bridge";
import { PART_TRIAL_SCHEMA_VERSION, type Plan, type PlanPart } from "@penguin/protocol";

import { handleRequest, type GatewayHandlers } from "../src/gateway.ts";
import { BridgeRegistry } from "../../../services/project-agent/src/bridge-registry.ts";
import type { BridgeCaller } from "../../../services/project-agent/src/issue-index.ts";
import { claimPartTrials, PartTrialStore, queueTrials, recordPartTrial } from "../../../services/project-agent/src/part-trial.ts";
import { ReviewStore } from "../../../services/project-agent/src/review-submit.ts";
import { sqlite } from "../../../services/project-agent/test/issues-repo.ts";

const SERVER = "https://penguin.example";
const OPTIONS = { deployerToken: "deployer-secret-for-tests" };
const SHA = "a".repeat(40);

const PART = {
  partId: "utc-day/v1#1",
  revision: 1,
  place: { kind: "scope", scope: "analytics" },
  scopes: ["analytics"],
  diff: { source: "commit", repo: "feature-utc-day", commit: "b".repeat(40), base: SHA, patch: null, files: [] },
} as unknown as PlanPart;
const PLAN = { planId: "utc-day/v1", featureId: "utc-day", facts: { change: { checkpoint: "c".repeat(40), baseline: SHA } }, parts: [PART] } as unknown as Plan;

async function deployment() {
  const sql = sqlite().sql;
  const registry = new BridgeRegistry(sql);
  const trials = new PartTrialStore(sql);
  const reviews = new ReviewStore(sql);
  const handlers = {
    bridges: () => ({
      authenticateBridge: (token: string) => registry.authenticate(token),
      // As ProjectAgent.claimPartTrials and reportPartTrial.
      claimPartTrials: (caller: BridgeCaller) => claimPartTrials(trials, caller),
      reportPartTrial: (caller: BridgeCaller, trialId: number, body: unknown) => recordPartTrial({ trials, reviews, routeToOwner: () => undefined }, caller, trialId, body),
    }),
    huddles: () => ({}),
    ownerForkRepo: (owner: string) => `owner-${owner}`,
    projectRepos: { issues: "issues", base: "base" },
    mintToken: () => Promise.reject(new Error("no Artifacts in this test")),
  } as unknown as GatewayHandlers;
  const fetchImpl: Fetch = async (input, init) => handleRequest(new Request(input, init), OPTIONS, handlers);
  const register = async (bridge: string, role: "owner" | "runner"): Promise<string> => {
    const { code } = await registry.issueCode(bridge, role, 600);
    const publicKey = await crypto.subtle.exportKey("jwk", (await generateSigningKeyPair()).publicKey);
    const outcome = await registry.register(code, publicKey);
    assert.equal(outcome.status, "registered");
    return outcome.status === "registered" ? outcome.bridge.bridgeToken : "";
  };
  return { trials, reviews, fetchImpl, register };
}

test("a runner claims a part trial and reports it once; an owner's bridge does neither", async () => {
  const { trials, reviews, fetchImpl, register } = await deployment();
  const [queued] = queueTrials({ trials, reviews }, PLAN);
  const runner = await register("runner-1", "runner");
  const owner = await register("bridge-jun", "owner");
  await assert.rejects(claimOver(SERVER, owner, fetchImpl), RemoteRefusedError);
  const [claimed] = await claimOver(SERVER, runner, fetchImpl);
  assert.deepEqual([claimed?.trialId, claimed?.partId, claimed?.target.sha], [queued?.id, PART.partId, SHA]);
  const report = {
    schemaVersion: PART_TRIAL_SCHEMA_VERSION,
    trialId: claimed?.trialId as number,
    partId: PART.partId,
    revision: 1,
    checkpoint: "c".repeat(40),
    target: SHA,
    status: "built" as const,
    tree: "d".repeat(40),
    reason: null,
    tests: [{ scopeId: "analytics", commandId: "test:analytics", status: "passed" as const, breaks: [], reason: null, durationMs: 4 }],
    reviews: [],
    durationMs: 9,
  };
  await assert.rejects(reportPartTrial(SERVER, owner, report.trialId, report, fetchImpl), RemoteRefusedError);
  await assert.rejects(reportPartTrial(SERVER, runner, report.trialId, { ...report, revision: 2 }, fetchImpl), RemoteRefusedError);
  assert.deepEqual(await reportPartTrial(SERVER, runner, report.trialId, report, fetchImpl), { status: "recorded", trialId: report.trialId, partId: PART.partId, revision: 1 });
  await assert.rejects(reportPartTrial(SERVER, runner, report.trialId, report, fetchImpl), /HTTP 409/u);
  assert.equal(trials.get(report.trialId)?.state, "recorded");
});
