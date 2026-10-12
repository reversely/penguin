// Runner mode's block runs (PRD 0.4 section 4.5): claim each block Penguin asks to check, run the
// checks of section 5.1 on the feature's checkpoint merged onto main and onto every other running
// feature's fork head, and report to POST /blocks/<run id>. Penguin promotes main itself when a land
// run passes; the runner never holds a token on main.
//
// - The runner fetches the base repo, the feature's fork and every target's fork with read tokens
//   into its own repository, as it does for tool runs (tool-run.ts).
// - The checks are the combined run's (combined-run.ts) with `mainTests`: every scope's tests run on
//   main's merged tree as well, because main moves to exactly that tree. Each target's tests run for
//   the scopes the impact graph shows it uses.
// - The change is the checkpoint against its merge base with main, so a plan check of a checkpoint
//   that has not taken main yet still names only the feature's own change.
// - Each failed or erred check gets its one next step from the resolution ladder (`classifyCheck`),
//   routed by the originating agent's charter, which the claim carries.
//
// A run whose forks or commits cannot be fetched is reported as failed with the reason, which
// releases it for any runner's next claim. A run that cannot check reports an `error` check on main,
// which never passes.

import { runGit } from "@penguin/git-analysis";
import {
  BLOCK_CHECK_LIMITS,
  BLOCK_LIMITS,
  BLOCK_SCHEMA_VERSION,
  CHECK_COMMAND_IDS,
  MAIN_TARGET,
  type BlockCheck,
  type BlockRunReport,
  type BlockRunRequest,
} from "@penguin/protocol";

import { loadScopeMap } from "./command-allowlist.ts";
import type { CombinedRunner } from "./combined-run.ts";
import type { BlockRunReply } from "./penguin-client.ts";
import { classifyCheck, DEFAULT_ROUND_LIMIT, loadIdentities, routingContext } from "./resolution.ts";
import { hasCommit } from "./runner-repo.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";

export interface BlockPassOptions {
  /** Claims the waiting runs, such as `claimBlockRuns` bound to the bridge token. */
  readonly claim: () => Promise<readonly BlockRunRequest[]>;
  /** Reports one run, such as `reportBlockRun` bound to the bridge token. */
  readonly report: (report: BlockRunReport) => Promise<BlockRunReply>;
  /** Makes every commit of a project repo (`base` or `feature-<id>`) available in `repoPath`. */
  readonly fetchRepo: (repo: string) => Promise<void>;
  /** Runs the checks; its runner must hold consent for the scopes' tests. */
  readonly combined: CombinedRunner;
  /** The runner's repository. */
  readonly repoPath: string;
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface BlockRunResult {
  readonly runId: string;
  readonly purpose: BlockRunRequest["purpose"];
  /** The report sent, or null when the run did not run. */
  readonly report: BlockRunReport | null;
  /** Penguin's answer, or null when nothing was reported. */
  readonly reply: BlockRunReply | null;
  /** Why the run stopped; a run that did not run is then reported as failed. */
  readonly error: string | null;
  /** What Penguin did with the run that did not run; null otherwise or when it could not be reported. */
  readonly failure: FailureNote | null;
}

export interface BlockPassResult {
  readonly claimed: number;
  readonly runs: readonly BlockRunResult[];
  readonly durationMs: number;
}

/** Claims, checks and reports every waiting block run once. Each repo is fetched once a pass. */
export async function blockPass(options: BlockPassOptions): Promise<BlockPassResult> {
  const started = performance.now();
  const claimed = await options.claim();
  const fetched = new Map<string, Promise<void>>();
  const fetchOnce = (repo: string): Promise<void> => {
    if (!fetched.has(repo)) fetched.set(repo, options.fetchRepo(repo));
    return fetched.get(repo) as Promise<void>;
  };
  const runs: BlockRunResult[] = [];
  for (const run of claimed) runs.push(await runOne(options, run, fetchOnce));
  return { claimed: claimed.length, runs, durationMs: Math.round(performance.now() - started) };
}

async function runOne(options: BlockPassOptions, run: BlockRunRequest, fetchRepo: (repo: string) => Promise<void>): Promise<BlockRunResult> {
  const base = { runId: run.runId, purpose: run.purpose };
  const started = performance.now();
  try {
    for (const repo of ["base", run.fork, ...run.targets.map((target) => target.fork)]) await fetchRepo(repo);
    for (const sha of [run.main, run.checkpoint, ...run.targets.map((target) => target.sha)]) {
      if (!(await hasCommit(options.repoPath, sha))) throw new Error(`commit ${sha} is not in the fetched repos`);
    }
  } catch (error) {
    const reason = (error as Error).message;
    return { ...base, report: null, reply: null, error: reason, failure: await noteFailure(options.fail, "block", run.runId, reason) };
  }
  let report: BlockRunReport;
  try {
    report = await check(options, run);
  } catch (error) {
    report = erred(run, `the block could not be checked: ${(error as Error).message}`);
  }
  report = { ...report, durationMs: Math.round(performance.now() - started) };
  try {
    return { ...base, report, reply: await options.report(report), error: null, failure: null };
  } catch (error) {
    return { ...base, report, reply: null, error: (error as Error).message, failure: null };
  }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const bounded = (text: string): string => text.slice(0, BLOCK_LIMITS.summaryLength);

async function check(options: BlockPassOptions, run: BlockRunRequest): Promise<BlockRunReport> {
  const baseline = (await runGit(options.repoPath, ["merge-base", "--end-of-options", run.main, run.checkpoint])).trim();
  const combined = await options.combined.run({
    checkpointSha: run.checkpoint,
    baselineSha: baseline,
    targets: run.targets.map((target) => ({ id: target.feature, person: target.person, checkpoint: target.sha })),
    mainSha: run.main,
    mainTests: true,
  });
  const checks: BlockCheck[] = (combined.checks ?? []).slice(0, BLOCK_CHECK_LIMITS.checks).map((each) => ({ ...each, planId: run.planId }));
  const failing = checks.filter((each) => each.result === "failed" || each.result === "error");
  const scopeMap = await loadScopeMap(options.repoPath, run.checkpoint);
  const { handle, person, scopes, paths } = run.charter;
  const seeded = (await loadIdentities(options.repoPath, run.checkpoint)).filter((identity) => identity.handle !== handle);
  const context = routingContext(scopeMap, [{ handle, owner: person, charterScopes: scopes, charterPaths: paths }, ...seeded], handle, DEFAULT_ROUND_LIMIT);
  const decisions = failing.map((each) => classifyCheck(each, combined, context));
  const places = [...new Set(failing.map((each) => `${each.target} ${each.check}`))];
  const summary = `${plural(checks.length, "check")} on main and ${plural(run.targets.length, "fork")}, ${failing.length} failing${places.length === 0 ? "" : `: ${places.join(", ")}`}`;
  return { schemaVersion: BLOCK_SCHEMA_VERSION, runId: run.runId, checkpoint: run.checkpoint, main: run.main, checks, decisions, summary: bounded(summary), durationMs: 0 };
}

/** A report whose one check says the block could not be checked: an `error` never passes. */
function erred(run: BlockRunRequest, message: string): BlockRunReport {
  const check: BlockCheck = {
    planId: run.planId,
    target: MAIN_TARGET,
    check: "merge",
    result: "error",
    tool: { name: "git", version: null, commandId: CHECK_COMMAND_IDS.merge },
    input: { origin: run.checkpoint, target: run.main, merged: null, paths: null },
    findings: [],
    findingCount: 0,
    summary: message.slice(0, BLOCK_CHECK_LIMITS.messageLength),
    fingerprint: null,
    logRef: null,
    durationMs: 0,
  };
  return { schemaVersion: BLOCK_SCHEMA_VERSION, runId: run.runId, checkpoint: run.checkpoint, main: run.main, checks: [check], decisions: [], summary: bounded(message), durationMs: 0 };
}

export function formatBlockPass(result: BlockPassResult): string {
  const lines: string[] = [];
  for (const run of result.runs) {
    const name = `Block run ${run.runId} (${run.purpose})`;
    if (run.error !== null && run.report === null) lines.push(`${name} stopped; ${failureText(run.failure)}: ${run.error}`);
    else if (run.error !== null) lines.push(`${name}: ${run.report?.summary}, not reported: ${run.error}`);
    else {
      const promotion = run.reply?.promotion;
      const landed = promotion == null ? "" : `; main moved from ${promotion.mainBefore.slice(0, 12)} to ${promotion.mainAfter.slice(0, 12)}`;
      const retried = run.reply?.retried == null ? "" : `; main had moved, so the land ${run.reply.retried.runId === undefined ? `went back: ${run.reply.retried.reason}` : `is checked again as ${run.reply.retried.runId}`}`;
      lines.push(`${name}: ${run.reply?.state}, ${run.report?.summary}${landed}${retried}.`);
    }
  }
  lines.push(`${plural(result.claimed, "block run")} claimed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
