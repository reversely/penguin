// Runner mode's combined runs (PRD section 4, Layer 1): claim the combined runs Penguin scheduled
// when a checkpoint changed a depended-on scope, run them with `CombinedRunner`, and report each
// trigger's results to POST /combined-runs, which opens a Huddle issue when tests failed.
//
// A claimed run names commands by ID only. Each ID must resolve in `penguin/scopes.json` as
// committed at the trigger checkpoint; an ID that does not is refused and never runs. Every step is
// a local Git or test command plus the claim and the report; nothing calls a model.

import type { CombinedRunEvent } from "@penguin/protocol";

import { resolveCommand } from "./command-allowlist.ts";
import { combinedRunEvent, CombinedRunner, type CombinedResult } from "./combined-run.ts";
import { penguinRemote, type RemoteResolver } from "./git-remote.ts";
import type { ClaimedCombinedRun, CombinedRunReply } from "./penguin-client.ts";
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
    if (commandIds.length === 0) return { ...base, refused, results: [], reply: null, error: null };

    const report = await new CombinedRunner({ repoPath: options.repoPath, runner: options.runner }).run({
      checkpointSha: trigger.sha,
      baselineSha: trigger.baselineSha,
      latestCheckpoints,
      commandIds,
    });
    // Only the claimed owners' results: another dependent owner has a run of their own, or none.
    const results = report.results.filter((result: CombinedResult) => Object.hasOwn(latestCheckpoints, result.ownerId));
    const reply = await options.report(combinedRunEvent({ ...report, results }, trigger.ownerId));
    const summary = results.map(({ ownerId, scopeId, status }) => ({ ownerId, scopeId, status }));
    return { ...base, refused, results: summary, reply, error: null };
  } catch (error) {
    return { ...base, refused, results: [], reply: null, error: (error as Error).message };
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
    for (const ownerId of ownerIds) {
      const fork = `owner-${ownerId}`;
      await remotes(penguinRemote(fork)).git(repoPath, (url) => [
        "fetch",
        "--quiet",
        "--no-tags",
        url,
        `+refs/heads/*:refs/penguin/${fork}/*`,
      ]);
    }
  };
}
