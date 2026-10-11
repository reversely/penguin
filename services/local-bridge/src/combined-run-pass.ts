// Runner mode's combined runs (PRD section 4, Layer 1): claim the combined runs Penguin scheduled
// when a checkpoint changed a depended-on scope, run them with `CombinedRunner`, and report each
// trigger's results to POST /combined-runs, which opens a Huddle issue when tests failed.
//
// A claimed run names commands by ID only. Each ID must resolve in `penguin/scopes.json` as
// committed at the trigger checkpoint; an ID that does not is refused and never runs. Every step is
// a local Git or test command plus the claim and the report; nothing calls a model.

import { MAIN_TARGET, type CombinedRunEvent } from "@penguin/protocol";

import type { BlockChecker } from "./block-checks.ts";
import { resolveCommand } from "./command-allowlist.ts";
import { combinedRunEvent, CombinedRunner, type CombinedResult } from "./combined-run.ts";
import type { RemoteResolver } from "./git-remote.ts";
import type { ImpactAnalyzer } from "./impact-analysis.ts";
import type { ClaimedCombinedRun, CombinedRunReply } from "./penguin-client.ts";
import { fetchRepoBranches } from "./runner-repo.ts";
import type { TestRunner } from "./test-runner.ts";

export interface CombinedPassOptions {
  /** Claims the scheduled runs, such as `claimCombinedRuns` bound to the bridge token. */
  readonly claim: () => Promise<readonly ClaimedCombinedRun[]>;
  /** Reports one trigger's results, such as `reportCombinedRun` bound to the bridge token. */
  readonly report: (event: CombinedRunEvent) => Promise<CombinedRunReply>;
  /** Makes every commit of these owners' forks available in `repoPath`. */
  readonly fetchForks: (ownerIds: readonly string[]) => Promise<void>;
  /** The runner's repository, where checkpoints are merged and tests run in throwaway worktrees. */
  readonly repoPath: string;
  readonly runner: TestRunner;
  /** Selects the owners whose tests run; an unselected owner's run completes as not affected. */
  readonly impact?: ImpactAnalyzer;
  /** Runs the section 5.1 checks on each merged tree; their results go out with the report. */
  readonly checks?: BlockChecker;
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
  readonly results: readonly { readonly ownerId: string; readonly scopeId: string; readonly status: string }[];
  /** The block checks that failed or could not run, by target. */
  readonly failedChecks: readonly {
    readonly target: string;
    readonly check: string;
    readonly result: string;
    readonly summary: string;
  }[];
  /** Penguin's answer to the report, or null when nothing was reported. */
  readonly reply: CombinedRunReply | null;
  /** Why the batch stopped; its runs stay claimed until their lease runs out and are then run again. */
  readonly error: string | null;
}

export interface CombinedPassResult {
  readonly claimed: number;
  readonly batches: readonly CombinedBatchResult[];
  readonly durationMs: number;
}

/**
 * Splits claimed runs into batches with one trigger and at most one run per dependent owner, since a
 * combined run merges the trigger with one checkpoint per owner. Every run of a trigger lands in a
 * batch together when it can, so one report covers every owner the trigger affects.
 */
export function batchRuns(runs: readonly ClaimedCombinedRun[]): ClaimedCombinedRun[][] {
  const batches: ClaimedCombinedRun[][] = [];
  for (const run of runs) {
    const batch = batches.find(
      (candidate) =>
        sameTrigger(candidate[0] as ClaimedCombinedRun, run) && !candidate.some((other) => other.ownerId === run.ownerId),
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
  for (const batch of batchRuns(claimed)) batches.push(await runBatch(options, batch));
  return { claimed: claimed.length, batches, durationMs: Math.round(performance.now() - started) };
}

async function runBatch(options: CombinedPassOptions, runs: readonly ClaimedCombinedRun[]): Promise<CombinedBatchResult> {
  const { trigger } = runs[0] as ClaimedCombinedRun;
  const base = { trigger, runIds: runs.map((run) => run.runId) };
  const refused: RefusedCommand[] = [];
  try {
    await options.fetchForks([...new Set([trigger.ownerId, ...runs.map((run) => run.ownerId)])]);
    const latestCheckpoints: Record<string, string> = {};
    const commandIds: string[] = [];
    for (const run of runs) {
      const allowed = await allowlisted(options.repoPath, trigger.sha, run, refused);
      if (allowed.length === 0) continue;
      latestCheckpoints[run.ownerId] = run.ownerCheckpoint;
      commandIds.push(...allowed);
    }
    if (commandIds.length === 0) return { ...base, refused, results: [], failedChecks: [], reply: null, error: null };

    const { repoPath, runner, impact, checks: checker } = options;
    const report = await new CombinedRunner({ repoPath, runner, impact, checks: checker }).run({
      checkpointSha: trigger.sha,
      baselineSha: trigger.baselineSha,
      latestCheckpoints,
      commandIds,
    });
    // Only the claimed owners' results: another dependent owner has a run of their own, or none.
    const claimed = (ownerId: string) => Object.hasOwn(latestCheckpoints, ownerId);
    const results = report.results.filter((result: CombinedResult) => claimed(result.ownerId));
    const checks = report.checks?.filter((check) => check.target === MAIN_TARGET || claimed(check.target));
    const reply = await options.report(combinedRunEvent({ ...report, results, checks }, trigger.ownerId));
    const summary = results.map(({ ownerId, scopeId, status }) => ({ ownerId, scopeId, status }));
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
      lines.push(`Combined run of ${trigger} stopped; it runs again after its lease: ${batch.error}`);
      continue;
    }
    const results = batch.results.map(({ scopeId, status }) => `${scopeId} ${status}`).join(", ");
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

/**
 * Fetches each owner's fork, `penguin:owner-<id>`, into `repoPath` under `refs/penguin/owner-<id>/`,
 * so the trigger, its baseline and each dependent checkpoint are local objects. The runner reads
 * other owners' forks, so `remotes` must hand out read tokens.
 */
export function forkFetcher(remotes: RemoteResolver, repoPath: string): (ownerIds: readonly string[]) => Promise<void> {
  return async (ownerIds) => {
    for (const ownerId of ownerIds) await fetchRepoBranches(repoPath, remotes, `owner-${ownerId}`);
  };
}
