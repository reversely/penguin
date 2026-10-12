// Test support for block runs: a Git server over fetch, as Artifacts serves repositories over smart
// HTTP, and the check runner's scripted report of a run.

import { execFileSync, spawnSync } from "node:child_process";

import {
  BLOCK_SCHEMA_VERSION,
  CHECK_COMMAND_IDS,
  MAIN_TARGET,
  type BlockCheck,
  type BlockCheckName,
  type BlockCheckResult,
  type BlockRunReport,
  type BlockRunRequest,
} from "@penguin/protocol";

import { pktLine } from "../src/main-push.ts";

/** Serves bare or working repositories over a fetch, as Artifacts serves them over smart HTTP. */
export function gitServer(repos: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const match = /^\/git\/([a-z0-9.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
    const dir = match === null ? undefined : repos[match[1] as string];
    if (match === null || dir === undefined) return new Response("not found", { status: 404 });
    const service = (match[2] === "info/refs" ? url.searchParams.get("service") : match[2]) as string;
    const program = service.replace(/^git-/u, "");
    if (match[2] === "info/refs") {
      const out = execFileSync("git", [program, "--stateless-rpc", "--advertise-refs", dir]);
      return new Response(Buffer.concat([pktLine(`# service=${service}\n`), Buffer.from("0000"), out]));
    }
    return new Response(spawnSync("git", [program, "--stateless-rpc", dir], { input: Buffer.from(init?.body as Uint8Array) }).stdout);
  }) as typeof fetch;
}

/** One check of a report, passing unless `result` says otherwise. */
function blockCheck(run: BlockRunRequest, target: string, check: BlockCheckName, result: BlockCheckResult = "passed"): BlockCheck {
  const commit = target === MAIN_TARGET ? run.main : (run.targets.find((each) => each.feature === target)?.sha as string);
  return {
    planId: run.planId,
    target,
    check,
    result,
    tool: { name: check === "tests" ? "test" : "git", version: null, commandId: check === "tests" ? "test:billing" : CHECK_COMMAND_IDS.merge },
    input: { origin: run.checkpoint, target: commit, merged: null, paths: null },
    findings: result === "failed" ? [{ path: "tax/tests/test_rounding.py", line: null, code: null, message: "fails: rounds each line" }] : [],
    findingCount: result === "failed" ? 1 : 0,
    summary: result === "failed" ? "1 failing test" : "passed",
    fingerprint: null,
    logRef: null,
    durationMs: 3,
  };
}

/** The runner's report of `run`: a merge and tests per target, with `failing` failing. */
export function reportOf(run: BlockRunRequest, failing: readonly { target: string; check: BlockCheckName }[] = []): BlockRunReport {
  const checks: BlockCheck[] = [];
  for (const target of [MAIN_TARGET, ...run.targets.map((each) => each.feature)]) {
    for (const check of ["merge", "tests"] as const) {
      const fails = failing.some((each) => each.target === target && each.check === check);
      checks.push(blockCheck(run, target, check, fails ? "failed" : "passed"));
    }
  }
  const decisions = failing.map(({ target, check }) => ({
    target,
    check,
    failure: "behaviour" as const,
    step: 5 as const,
    nextStep: "the agent of the scope's owner adapts",
    actor: { kind: "owner-agent" as const, id: "@rahul/work" },
    fix: null,
    reason: "a behaviour change outside the originating charter",
    evidence: { summary: "1 failing test", findings: [] },
  }));
  return { schemaVersion: BLOCK_SCHEMA_VERSION, runId: run.runId, checkpoint: run.checkpoint, main: run.main, checks, decisions, summary: `${checks.length} checks`, durationMs: 40 };
}
