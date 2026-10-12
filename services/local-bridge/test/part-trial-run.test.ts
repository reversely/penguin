// The runner's side of part trials: a claimed trial is checked before anything runs, the client claims
// and reports with the bridge token, and one failing trial never stops another. The real trial trees,
// tests and reviews on the fixtures are in tests/integration/part-trial.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkTrialRequest, claimPartTrials, partTrialPass, RemoteRefusedError, reportPartTrial, trialRepos, type Fetch } from "@penguin/local-bridge";
import { PART_TRIAL_SCHEMA_VERSION, type PartTrialReport, type PartTrialRequest } from "@penguin/protocol";

const SERVER = "https://penguin.example";
const SHA = "a".repeat(40);
const REQUEST: PartTrialRequest = {
  trialId: 4,
  feature: "utc-day",
  planId: "utc-day/v1",
  partId: "utc-day/v1#1",
  revision: 1,
  fork: "feature-utc-day",
  checkpoint: SHA,
  target: { id: "main", repo: "base", sha: SHA },
  fix: { kind: "commit", repo: "feature-utc-day", commit: SHA, base: SHA },
  commandIds: ["test:analytics"],
  reviews: [],
};
const REPORT: PartTrialReport = {
  schemaVersion: PART_TRIAL_SCHEMA_VERSION,
  trialId: 4,
  partId: "utc-day/v1#1",
  revision: 1,
  checkpoint: SHA,
  target: SHA,
  status: "conflict",
  tree: null,
  reason: "the checkpoint's merge conflicts in a.py",
  tests: [],
  reviews: [],
  durationMs: 1,
};

test("a claimed trial names only project repos, full SHAs and test commands, or nothing runs", () => {
  checkTrialRequest(REQUEST);
  assert.deepEqual(trialRepos(REQUEST), ["feature-utc-day", "base"]);
  const bad: PartTrialRequest[] = [
    { ...REQUEST, fork: "owner-jun" },
    { ...REQUEST, checkpoint: "HEAD" },
    { ...REQUEST, target: { ...REQUEST.target, repo: "--upload-pack=x" } },
    { ...REQUEST, fix: { kind: "commit", repo: "feature-utc-day", commit: "main", base: SHA } },
    { ...REQUEST, commandIds: ["lint:ruff"] },
  ];
  for (const request of bad) assert.throws(() => checkTrialRequest(request), JSON.stringify(request));
});

test("the client claims trials and reports one with the bridge token; a refused report is not retried", async () => {
  const requests: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    requests.push({ url: href, auth: new Headers(init?.headers).get("Authorization"), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (href.endsWith("/part-trials/claim")) return Response.json({ trials: [REQUEST] });
    if (href.endsWith("/4")) return Response.json({ status: "superseded", trialId: 4, partId: REQUEST.partId, revision: 1 });
    return Response.json({ error: "invalid", message: "bad" }, { status: 400 });
  }) as Fetch;
  assert.deepEqual(await claimPartTrials(SERVER, "bridge-token", fetchStub), [REQUEST]);
  assert.deepEqual(await reportPartTrial(SERVER, "bridge-token", 4, REPORT, fetchStub), { status: "superseded", trialId: 4, partId: REQUEST.partId, revision: 1 });
  await assert.rejects(reportPartTrial(SERVER, "bridge-token", 5, REPORT, fetchStub), RemoteRefusedError);
  assert.deepEqual(
    requests.map(({ url, auth }) => [url, auth]),
    [
      [`${SERVER}/part-trials/claim`, "Bearer bridge-token"],
      [`${SERVER}/part-trials/4`, "Bearer bridge-token"],
      [`${SERVER}/part-trials/5`, "Bearer bridge-token"],
    ],
  );
  assert.deepEqual(requests[1]?.body, REPORT);
});

test("a pass reports each trial it could run and lists the ones it could not", async () => {
  const result = await partTrialPass({
    claim: async () => [REQUEST, { ...REQUEST, trialId: 5 }],
    fetch: async (request) => {
      if (request.trialId === 4) throw new Error("the fork could not be fetched");
    },
    run: async (request) => ({ ...REPORT, trialId: request.trialId }),
    report: async () => ({ status: "recorded" }),
  });
  assert.equal(result.claimed, 2);
  assert.deepEqual(
    result.reported.map(({ trialId, status, summary }) => [trialId, status, summary]),
    [[5, "recorded", "no trial tree: the checkpoint's merge conflicts in a.py"]],
  );
  assert.deepEqual(result.failed, [{ trialId: 4, error: "the fork could not be fetched", failure: null }]);
});
