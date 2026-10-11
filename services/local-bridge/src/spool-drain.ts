// Draining the outbound spool, once or in a retry loop. A drain pushes every queued entry whose
// remote is reachable and appends an acknowledgement for each; entries whose remote is not
// reachable stay queued for the next attempt.

import { pushCheckpoint } from "./checkpoint-push.ts";
import { checkpointReportFor, unregisteredReporter, type CheckpointReporter } from "./checkpoint-report.ts";
import { unregisteredRemotes, type RemoteResolver } from "./git-remote.ts";
import { authorOwner, IssuesClone, RemoteUnavailableError } from "./issues-clone.ts";
import type { CheckpointEntry, OperationEntry, Spool } from "./spool.ts";

export interface DrainResult {
  readonly pushed: readonly { readonly id: string; readonly commit: string }[];
  /** Refused for good; acknowledged as failed and not retried. */
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
  /** Still queued because the remote is unreachable or the push did not go through. */
  readonly waiting: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Drains the spool under its lock. `remotes` resolves each entry's remote name; without it only
 * local paths are reachable and Artifacts entries stay queued. `reporter` sends checkpoint reports
 * to Penguin; without it they stay queued.
 */
export function drainSpool(
  spool: Spool,
  remotes: RemoteResolver = unregisteredRemotes,
  reporter: CheckpointReporter = unregisteredReporter,
): Promise<DrainResult> {
  return spool.withLock(() => drainLocked(spool, remotes, undefined, reporter));
}

/**
 * Drains the spool. The caller holds the spool lock. Operations are grouped by the clone they push
 * through and pushed together; checkpoints are pushed one at a time in the order they were queued.
 * `synced` is a clone the caller has just synced online; its group skips a second fetch. A
 * checkpoint pushed to an Artifacts fork queues a report, and reports are sent last.
 */
export async function drainLocked(
  spool: Spool,
  remotes: RemoteResolver = unregisteredRemotes,
  synced?: IssuesClone,
  reporter: CheckpointReporter = unregisteredReporter,
): Promise<DrainResult> {
  const pushed: { id: string; commit: string }[] = [];
  const failed: { id: string; reason: string }[] = [];
  const waiting: { id: string; reason: string }[] = [];

  const operations = new Map<string, OperationEntry[]>();
  const checkpoints = new Map<string, CheckpointEntry[]>();
  for (const entry of await spool.pending()) {
    if (entry.kind === "operation") append(operations, [entry.remote, entry.clone, entry.branch].join("\0"), entry);
    else if (entry.kind === "checkpoint") append(checkpoints, [entry.fork, entry.ref].join("\0"), entry);
  }

  for (const entries of operations.values()) {
    const [first] = entries;
    const clone =
      synced?.clonePath === first!.clone
        ? synced
        : new IssuesClone({
            remote: first!.remote,
            remotes,
            clonePath: first!.clone,
            branch: first!.branch,
            ownerId: authorOwner(first!.operation.author) ?? "penguin",
            maxPushAttempts: 5,
          });
    try {
      const outcome = await clone.publish(entries);
      const acks = [
        ...[...outcome.pushed].map(([id, commit]) => ({ kind: "pushed" as const, id, commit })),
        ...outcome.failed.map(({ id, reason }) => ({ kind: "failed" as const, id, reason })),
      ];
      // Acknowledge each group as soon as it lands, so a crash later loses no acknowledgement.
      await spool.acknowledge(acks);
      for (const [id, commit] of outcome.pushed) pushed.push({ id, commit });
      failed.push(...outcome.failed);
    } catch (error) {
      const reason = error instanceof RemoteUnavailableError ? error.message : `the drain failed: ${(error as Error).message}`;
      for (const entry of entries) waiting.push({ id: entry.id, reason });
    }
  }

  for (const entries of checkpoints.values()) {
    for (const [index, entry] of entries.entries()) {
      const result = await pushCheckpoint(entry, remotes);
      if (result.status === "waiting") {
        // A later checkpoint on the same branch builds on this one; keep them in order.
        for (const later of entries.slice(index)) waiting.push({ id: later.id, reason: result.reason });
        break;
      }
      if (result.status === "pushed") {
        // The report is queued before the push is acknowledged: a crash between the two pushes
        // again (a no-op) and queues the same report ID, which the spool keeps once.
        const report = checkpointReportFor(entry);
        if (report !== undefined) await spool.enqueue(report);
        await spool.acknowledge([{ kind: "pushed", id: entry.id, commit: entry.sha }]);
        pushed.push({ id: entry.id, commit: entry.sha });
      } else {
        await spool.acknowledge([{ kind: "failed", id: entry.id, reason: result.reason }]);
        failed.push({ id: entry.id, reason: result.reason });
      }
    }
  }

  // Read again: the checkpoint pushes above queue reports of their own.
  for (const entry of await spool.pending()) {
    if (entry.kind !== "checkpoint-report") continue;
    const result = await reporter(entry);
    if (result.status === "waiting") {
      waiting.push({ id: entry.id, reason: result.reason });
    } else if (result.status === "reported") {
      await spool.acknowledge([{ kind: "pushed", id: entry.id, commit: entry.sha }]);
      pushed.push({ id: entry.id, commit: entry.sha });
    } else {
      await spool.acknowledge([{ kind: "failed", id: entry.id, reason: result.reason }]);
      failed.push({ id: entry.id, reason: result.reason });
    }
  }
  return { pushed, failed, waiting };
}

function append<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

export interface RetryLoopOptions {
  spool: Spool;
  /** Resolves each entry's remote name. Defaults to local paths only. */
  remotes?: RemoteResolver;
  /** Sends checkpoint reports to Penguin. Defaults to leaving them queued. */
  reporter?: CheckpointReporter;
  /** The first wait after a drain that left entries queued. Doubles up to `maxDelayMs`. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** The wait after a drain that left nothing queued, before checking for new entries. */
  idleDelayMs?: number;
  /** Called after every drain. */
  onDrain?: (result: DrainResult) => void;
}

/**
 * Drains the spool now and again after each wait, so queued pushes reach the remote once it is
 * reachable without the owner running anything. Waits back off while entries stay queued.
 */
export class RetryLoop {
  readonly #options: Required<RetryLoopOptions>;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;
  #delay: number;

  constructor(options: RetryLoopOptions) {
    this.#options = {
      minDelayMs: 1_000,
      maxDelayMs: 60_000,
      idleDelayMs: 30_000,
      onDrain: () => undefined,
      remotes: unregisteredRemotes,
      reporter: unregisteredReporter,
      ...options,
    };
    this.#delay = this.#options.minDelayMs;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  /** Stops the loop after any drain in progress finishes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#running = this.#tick();
    }, delay);
  }

  async #tick(): Promise<void> {
    const { spool, remotes, reporter, minDelayMs, maxDelayMs, idleDelayMs, onDrain } = this.#options;
    let next: number;
    try {
      const result = await drainSpool(spool, remotes, reporter);
      onDrain(result);
      if (result.waiting.length > 0) {
        next = this.#delay;
        this.#delay = Math.min(this.#delay * 2, maxDelayMs);
      } else {
        next = idleDelayMs;
        this.#delay = minDelayMs;
      }
    } catch {
      // The lock was held too long or the spool could not be read; try again later.
      next = this.#delay;
      this.#delay = Math.min(this.#delay * 2, maxDelayMs);
    }
    this.#schedule(next);
  }
}
