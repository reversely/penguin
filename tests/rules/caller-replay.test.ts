// The caller replay (#187): a running feature's tests run on its fork head and on the change merged
// onto it with the changed functions wrapped, and each caller in the feature's code gets one verdict.
// One test per verdict, from recordings shaped as the bridge's pytest plugin writes them, and one for
// the checks Penguin makes on a reported section. Names and values follow Larder's case 3.

import assert from "node:assert/strict";
import test from "node:test";

import { callerReplayProblems, parseBlockRunReport, parseCallerReplay, replayCall, type BlockRunRequest, type ImpactUse } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { callerReplaySection, parseCapture, replayTarget, type Capture, type CapturedCall, type ReplayTargetInput } from "../../services/local-bridge/src/caller-replay.ts";

const map = parseScopeMap({
  scopes: [
    { id: "platform", name: "Platform", owner: "hugo", paths: ["shared/platform/"], contracts: ["shared/platform/http.py::Client"], test_command: "true", depends_on: [] },
    { id: "payouts", name: "Payouts", owner: "kofi", paths: ["payouts/"], contracts: [], test_command: "true", depends_on: [{ scope: "platform", kind: "imports" }] },
  ],
});

const POST = { symbol: "shared.platform.http.Client.post", module: "shared.platform.http", qualname: "Client.post", contract: "shared/platform/http.py::Client" };
const TEST = "payouts/tests/test_send.py::test_timed_out_payout_is_paid_once";
const payout = { method: "POST", url: "https://processor.example.invalid/v1/payouts", body: { reference: "po-2", amount_cents: 480 }, headers: {} };

function call(outcome: CapturedCall["outcome"], payouts = 1, test = TEST): CapturedCall {
  return {
    symbol: POST.symbol,
    test,
    // The innermost frame is the platform's own helper; the caller is the feature's line under it.
    frames: [
      { path: "shared/platform/http.py", line: 20 },
      { path: "payouts/send.py", line: 18 },
      { path: "payouts/tests/test_send.py", line: 19 },
    ],
    args: { path: "/v1/payouts", json: payout.body },
    approximate: false,
    effects: Array.from({ length: payouts }, () => ({ kind: "request" as const, detail: payout })),
    effectCount: payouts,
    outcome,
  };
}

const capture = (calls: CapturedCall[], tests: Record<string, "passed" | "failed" | "error"> = { [TEST]: "passed" }): Capture => ({
  symbols: [{ symbol: POST.symbol, status: "wrapped", reason: null }],
  calls,
  tests: new Map(Object.entries(tests)),
  dropped: 0,
});

const sent = { status: "returned" as const, value: { $type: "Response", status: 200, json: { id: "mv_1" } } };
const timedOut = { status: "raised" as const, error: { type: "Timeout", message: "https://processor.example.invalid/v1/payouts" } };

const input = (old: Capture | string, now: Capture | string, uses: ImpactUse[] = []): ReplayTargetInput => ({
  feature: "instant-payouts",
  origin: "a".repeat(40),
  forkCommit: "b".repeat(40),
  mergedCommit: "c".repeat(40),
  scopes: ["payouts"],
  scopeMap: map,
  symbols: [POST],
  changedPaths: new Set(["shared/platform/http.py"]),
  uses,
  old,
  new: now,
  durationMs: 240,
});

test("unaffected: every call returns the same value with the same effects, so the caller is unaffected", () => {
  const { callers } = replayTarget(input(capture([call(sent)]), capture([call(sent)])));
  assert.deepEqual(callers.map((caller) => [caller.path, caller.line, caller.contract, caller.verdict, caller.calls]), [["payouts/send.py", 18, POST.contract, "unaffected", 1]]);
});

test("differs: a retried payout returns where it timed out and pays twice, so the caller differs with both payouts as effects", () => {
  const { run, callers } = replayTarget(input(capture([call(timedOut, 1)]), capture([call(sent, 2)], { [TEST]: "failed" })));
  const [caller] = callers;
  assert.equal(caller?.verdict, "differs");
  const [differing] = caller?.differing ?? [];
  assert.deepEqual(differing?.differs, ["result", "exception", "effects"]);
  assert.deepEqual(differing?.new.effects.map((effect) => effect.summary), ["POST https://processor.example.invalid/v1/payouts", "POST https://processor.example.invalid/v1/payouts"]);
  // The ids are fixed by what was compared, so a later citation finds the same call.
  const again = replayTarget(input(capture([call(timedOut, 1)]), capture([call(sent, 2)], { [TEST]: "failed" })));
  assert.equal(again.run.runId, run.runId);
  assert.equal(again.callers[0]?.differing[0]?.callId, differing?.callId);
  const section = callerReplaySection([{ run, callers }]);
  assert.equal(replayCall(section, run.runId, differing?.callId as string)?.caller.path, "payouts/send.py");
});

test("broken: a call raises on the merged tree where it returned, or a test dies before the call, or the caller's test fails with every call matching", () => {
  const raises = replayTarget(input(capture([call(sent)]), capture([call(timedOut)], { [TEST]: "failed" })));
  assert.equal(raises.callers[0]?.verdict, "broken");
  assert.match(raises.callers[0]?.reason ?? "", /raises Timeout on the merged tree where it returned/u);

  const dies = replayTarget(input(capture([call(sent)]), capture([], { [TEST]: "error" })));
  assert.equal(dies.callers[0]?.verdict, "broken");
  assert.equal(dies.callers[0]?.differing[0]?.new.status, "missing");

  const fails = replayTarget(input(capture([call(sent)]), capture([call(sent)], { [TEST]: "failed" })));
  assert.equal(fails.callers[0]?.verdict, "broken");
  assert.equal(fails.callers[0]?.differingCount, 0);
});

test("unknown_reach: a call the impact graph shows that no test reaches gets unknown_reach; so does every call when the command recorded nothing", () => {
  const use: ImpactUse = { path: "payouts/instant.py", line: 9, kind: "call", symbol: POST.symbol, name: "client.post", scope: "payouts" };
  const unreached = replayTarget(input(capture([call(sent)]), capture([call(sent)]), [use]));
  assert.deepEqual(
    unreached.callers.map((caller) => [caller.path, caller.verdict]),
    [
      ["payouts/instant.py", "unknown_reach"],
      ["payouts/send.py", "unaffected"],
    ],
  );
  const notPytest = replayTarget(input(parseCapture(null), parseCapture(null), [use]));
  assert.equal(notPytest.callers[0]?.verdict, "unknown_reach");
  assert.match(notPytest.run.error ?? "", /wrote no recording/u);
});

test("Penguin refuses a caller replay that names a run it lacks, a verdict its calls contradict, an oversized value or a fork the block did not name", () => {
  const { run, callers } = replayTarget(input(capture([call(timedOut, 1)]), capture([call(sent, 2)])));
  const section = callerReplaySection([{ run, callers }]);
  assert.equal(parseCallerReplay(JSON.parse(JSON.stringify(section))).ok, true);

  const orphan = { ...section, callers: section.callers.map((caller) => ({ ...caller, runId: "replay-00000000000000000000" })) };
  assert.equal(parseCallerReplay(orphan).ok, false);
  const contradicted = { ...section, callers: section.callers.map((caller) => ({ ...caller, verdict: "unaffected" })) };
  assert.equal(parseCallerReplay(contradicted).ok, false);
  const huge = structuredClone(section) as unknown as { callers: { differing: { new: { value: unknown } }[] }[] };
  (huge.callers[0]?.differing[0] as { new: { value: unknown } }).new.value = "x".repeat(5_000);
  assert.equal(parseCallerReplay(huge).ok, false);

  assert.deepEqual(callerReplayProblems(section, "a".repeat(40), new Map([["instant-payouts", "b".repeat(40)]])), []);
  assert.match(callerReplayProblems(section, "a".repeat(40), new Map([["tip-jar", "d".repeat(40)]])).join(), /does not name/u);
  const request = {
    runId: "dependency-audit/1",
    planId: null,
    checkpoint: "a".repeat(40),
    main: "e".repeat(40),
    targets: [{ feature: "tip-jar", person: "priya", fork: "feature-tip-jar", sha: "d".repeat(40) }],
  } as unknown as BlockRunRequest;
  const report = { schemaVersion: 1, runId: "dependency-audit/1", checkpoint: "a".repeat(40), main: "e".repeat(40), checks: [], decisions: [], summary: "", durationMs: 0, callerReplay: section };
  const parsed = parseBlockRunReport(report, request);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.problems.join(), /callerReplay\/runs\/0 replays instant-payouts/u);
});
