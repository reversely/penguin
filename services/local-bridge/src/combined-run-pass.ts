// Runner mode's combined runs (PRD section 4, Layer 1): claim the combined runs Penguin scheduled
// when a checkpoint changed a depended-on scope, run them with `CombinedRunner`, and report each
// trigger's results to POST /combined-runs, which opens a Huddle issue when tests failed. Each run
// names one target fork: a running feature's fork, or a person's owner fork.
//
// A claimed run names commands by ID only. Each ID must resolve in `penguin/scopes.json` as
// committed at the trigger checkpoint; an ID that does not is refused and never runs. Every step is
// a local Git or test command plus the claim and the report; nothing calls a model.

import { MAIN_TARGET, type CombinedRunEvent } from "@penguin/protocol";

import type { BlockChecker } from "./block-checks.ts";
import { resolveCommand } from "./command-allowlist.ts";
import { combinedRunEvent, CombinedRunner, type CombinedResult, type ForkTarget } from "./combined-run.ts";
import type { RemoteResolver } from "./git-remote.ts";
import type { ImpactAnalyzer } from "./impact-analysis.ts";
import type { ClaimedCombinedRun, CombinedRunReply } from "./penguin-client.ts";
import { fetchRepoBranches } from "./runner-repo.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";
import type { TestRunner } from "./test-runner.ts";

export interface CombinedPassOptions {
  /** Claims the scheduled runs, such as `claimCombinedRuns` bound to the bridge token. */
  readonly claim: () => Promise<readonly ClaimedCombinedRun[]>;
  /** Reports one trigger's results, such as `reportCombinedRun` bound to the bridge token. */
  readonly report: (event: CombinedRunEvent) => Promise<CombinedRunReply>;
  /** Makes every commit of these forks (`owner-<id>`, `feature-<id>`) available in `repoPath`. */
  readonly fetchForks: (forks: readonly string[]) => Promise<void>;
  /** The runner's repository, where checkpoints are merged and tests run in throwaway worktrees. */
  readonly repoPath: string;
  readonly runner: TestRunner;
  /** Selects the owners whose tests run; an unselected owner's run completes as not affected. */
  readonly impact?: ImpactAnalyzer;
  /** Runs the section 5.1 checks on each merged tree; their results go out with the report. */
  readonly checks?: BlockChecker;
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface RefusedCommand {
  readonly runId: string;
  readonly commandId: string;
  readonly reason: string;
}

/** One batch of claimed runs that share a trigger, run together and reported as one event. */
export interface CombinedBatchResult {
  readonly trigger: ClaimedCombinedRun["trigger"];
  readonly runIds: readonly string[];
  /** Command IDs that did not resolve in the repository config; none of them ran. */
  readonly refused: readonly RefusedCommand[];
  readonly results: readonly { readonly target: string; readonly ownerId: string; readonly scopeId: string; readonly status: string }[];
  /** The block checks that failed or could not run, by target. */
  readonly failedChecks: readonly {
    readonly target: string;
    readonly check: string;
    readonly result: string;
    readonly summary: string;
  }[];
  /** Penguin's answer to the report, or null when nothing was reported. */
  readonly reply: CombinedRunReply | null;
  /** Why the batch stopped; each of its runs is then reported as failed. */
  readonly error: string | null;
  /** What Penguin did with each run of a stopped batch, by run id; empty when the batch did not stop. */
  readonly failures: readonly { readonly runId: string; readonly note: FailureNote | null }[];
}

export interface CombinedPassResult {
  readonly claimed: number;
  readonly batches: readonly CombinedBatchResult[];
  readonly durationMs: number;
}

/**
 * Splits claimed runs into batches with one trigger and at most one run per target, since a combined
 * run merges the trigger with one checkpoint per target. Every run of a trigger lands in a batch
 * together when it can, so one report covers every target the trigger affects.
 */
export function batchRuns(runs: readonly ClaimedCombinedRun[]): ClaimedCombinedRun[][] {
  const batches: ClaimedCombinedRun[][] = [];
  for (const run of runs) {
    const batch = batches.find(
      (candidate) =>
        sameTrigger(candidate[0] as ClaimedCombinedRun, run) && !candidate.some((other) => other.target === run.target),
    );
    if (batch === undefined) batches.push([run]);
    else batch.push(run);
  }
  return batches;
}

function sameTrigger(a: ClaimedCombinedRun, b: ClaimedCombinedRun): boolean {
  return a.trigger.ownerId === b.trigger.ownerId && a.trigger.sha === b.trigger.sha && a.trigger.baselineSha === b.trigger.baselineSha;
}

/** Claims, runs and reports every scheduled combined run once. */
export async function combinedRunPass(options: CombinedPassOptions): Promise<CombinedPassResult> {
  const started = performance.now();
  const claimed = await options.claim();
  const batches: CombinedBatchResult[] = [];
  for (const batch of batchRuns(claimed)) {
    const result = await runBatch(options, batch);
    const failures = [];
    if (result.error !== null) for (const runId of result.runIds) failures.push({ runId, note: await noteFailure(options.fail, "combined", runId, result.error) });
    batches.push({ ...result, failures });
  }
  return { claimed: claimed.length, batches, durationMs: Math.round(performance.now() - started) };
}

async function runBatch(options: CombinedPassOptions, runs: readonly ClaimedCombinedRun[]): Promise<Omit<CombinedBatchResult, "failures">> {
  const { trigger } = runs[0] as ClaimedCombinedRun;
  const base = { trigger, runIds: runs.map((run) => run.runId) };
  const refused: RefusedCommand[] = [];
  try {
    await options.fetchForks([...new Set([`owner-${trigger.ownerId}`, ...runs.map((run) => run.fork)])]);
    // Each run is one target; its scopes are those of its allowlisted commands, so two targets of
    // one person can run different scopes.
    const targets: ForkTarget[] = [];
    for (const run of runs) {
      const allowed = await allowlisted(options.repoPath, trigger.sha, run, refused);
      if (allowed.length === 0) continue;
      const scopes = allowed.map((commandId) => commandId.slice("test:".length));
      targets.push({ id: run.target, person: run.ownerId, checkpoint: run.ownerCheckpoint, scopes });
    }
    if (targets.length === 0) return { ...base, refused, results: [], failedChecks: [], reply: null, error: null };

    const { repoPath, runner, impact, checks: checker } = options;
    const report = await new CombinedRunner({ repoPath, runner, impact, checks: checker }).run({
      checkpointSha: trigger.sha,
      baselineSha: trigger.baselineSha,
      targets,
    });
    // Only the claimed targets' results: another target has a run of its own, or none.
    const ids = new Set(targets.map((target) => target.id));
    const results = report.results.filter((result: CombinedResult) => result.status !== "no-checkpoint" && ids.has(result.target));
    const checks = report.checks?.filter((check) => check.target === MAIN_TARGET || ids.has(check.target));
    const reply = await options.report(combinedRunEvent({ ...report, results, checks }, trigger.ownerId));
    const summary = results.map(({ target, ownerId, scopeId, status }) => ({ target, ownerId, scopeId, status }));
    const failedChecks = (checks ?? [])
      .filter((check) => check.result === "failed" || check.result === "error")
      .map(({ target, check, result, summary: text }) => ({ target, check, result, summary: text }));
    return { ...base, refused, results: summary, failedChecks, reply, error: null };
  } catch (error) {
    return { ...base, refused, results: [], failedChecks: [], reply: null, error: (error as Error).message };
  }
}

/** The run's command IDs that resolve in the config at the trigger; the rest are recorded as refused. */
async function allowlisted(
  repoPath: string,
  triggerSha: string,
  run: ClaimedCombinedRun,
  refused: RefusedCommand[],
): Promise<string[]> {
  const allowed: string[] = [];
  for (const commandId of run.commandIds) {
    try {
      await resolveCommand(repoPath, triggerSha, commandId);
      allowed.push(commandId);
    } catch (error) {
      refused.push({ runId: run.runId, commandId, reason: (error as Error).message });
    }
  }
  return allowed;
}

export function formatCombinedPass(result: CombinedPassResult): string {
  const lines: string[] = [];
  for (const batch of result.batches) {
    const trigger = `${batch.trigger.ownerId}@${batch.trigger.sha.slice(0, 12)}`;
    for (const { commandId, reason } of batch.refused) lines.push(`Refused ${commandId} for ${trigger}: ${reason}`);
    if (batch.error !== null) {
      lines.push(`Combined run of ${trigger} stopped: ${batch.error}`);
      for (const { runId, note } of batch.failures) lines.push(`  ${runId}: ${failureText(note)}`);
      continue;
    }
    const results = batch.results.map(({ target, scopeId, status }) => `${scopeId} on ${target} ${status}`).join(", ");
    const reply = batch.reply === null ? "not reported" : `Penguin: ${batch.reply.status}`;
    const issue = batch.reply?.issueId === undefined ? "" : ` #${batch.reply.issueId}`;
    lines.push(`Combined run of ${trigger}: ${results || "nothing ran"} (${reply}${issue}).`);
    for (const check of batch.failedChecks) {
      lines.push(`  ${check.check} on ${check.target} ${check.result}: ${check.summary}`);
    }
  }
  lines.push(`${result.claimed} combined run${result.claimed === 1 ? "" : "s"} claimed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}

/** A fork a combined run fetches: an owner fork or a running feature's fork. */
export const COMBINED_RUN_FORK = /^(?:owner-[a-z0-9]+(?:-[a-z0-9]+)*|feature-[a-z0-9]+(?:[.-][a-z0-9]+)*)$/u;

/**
 * Fetches each fork, `penguin:owner-<id>` or `penguin:feature-<id>`, into `repoPath` under
 * `refs/penguin/<fork>/`, so the trigger, its baseline and each target's checkpoint are local
 * objects. The runner reads other people's forks, so `remotes` must hand out read tokens.
 */
export function forkFetcher(remotes: RemoteResolver, repoPath: string): (forks: readonly string[]) => Promise<void> {
  return async (forks) => {
    for (const fork of forks) {
      if (!COMBINED_RUN_FORK.test(fork)) throw new Error(`${JSON.stringify(fork)} is not an owner or feature fork`);
      await fetchRepoBranches(repoPath, remotes, fork);
    }
  };
}
