// Runner mode (PRD sections 5 and 10): on each pass the integration runner lists the operations
// Penguin applied from MCP, the dashboard and itself, writes each file at its path in the runner's
// clone of the issues repo, makes one commit and pushes once. That push's event reaches the
// ProjectAgent, which clears the operations' PendingOp rows. An operation already in the repo with
// the same bytes is skipped, so a pass that runs before the event lands pushes nothing twice.

import { operationPath, parseOperationFile } from "@penguin/protocol";

import { isOperationPath, type IssuesClone } from "./issues-clone.ts";
import type { PendingOperation } from "./penguin-client.ts";

export interface RunnerPassResult {
  /** How many operations Penguin listed as pending. */
  readonly listed: number;
  /** The one pushed commit, or null when the pass wrote nothing. */
  readonly commit: string | null;
  /** op_ids written in `commit`. */
  readonly written: readonly string[];
  /** op_ids whose file the repo already held with the same bytes. */
  readonly skipped: readonly string[];
  /** Operations left unwritten, with the reason. They stay pending. */
  readonly refused: readonly { readonly opId: string; readonly reason: string }[];
  readonly durationMs: number;
}

export interface RunnerPassOptions {
  /** Lists the pending operations, such as `fetchPendingOperations` bound to the bridge token. */
  readonly list: () => Promise<readonly PendingOperation[]>;
  readonly clone: IssuesClone;
}

/**
 * Why a listed operation must not be written, or null when it may. The runner writes a file only at
 * the path the operation file rule (#5) gives the operation the file holds: `issues/<issue>/ops/<op_id>.json`.
 * Penguin's listing is not trusted for the path, so a wrong or crafted path writes nothing.
 */
export function pendingProblem(entry: PendingOperation): string | null {
  const parsed = parseOperationFile(new TextEncoder().encode(entry.file));
  if (!parsed.ok) return "the file is not a valid operation";
  if (parsed.operation.op_id !== entry.opId) return "the file's op_id is not the listed op_id";
  let path: string;
  try {
    path = operationPath(parsed.operation);
  } catch {
    return "the operation has no valid file path";
  }
  if (path !== entry.path || !isOperationPath(entry.path)) return "the listed path is not the operation's own path";
  return null;
}

/** Runs one pass: list, check, write, one commit, one push. The caller holds the spool lock. */
export async function runnerPass(options: RunnerPassOptions): Promise<RunnerPassResult> {
  const started = performance.now();
  const pending = await options.list();
  const refused: { opId: string; reason: string }[] = [];
  const accepted: PendingOperation[] = [];
  for (const entry of pending) {
    const problem = pendingProblem(entry);
    if (problem === null) accepted.push(entry);
    else refused.push({ opId: entry.opId, reason: problem });
  }
  if (accepted.length === 0) {
    return { listed: pending.length, commit: null, written: [], skipped: [], refused, durationMs: elapsed(started) };
  }

  const opIdOf = new Map(accepted.map((entry) => [entry.path, entry.opId]));
  const outcome = await options.clone.publishBatch(
    accepted.map((entry) => ({ path: entry.path, text: entry.file })),
    // The message holds only a count, never an operation's title, body or reason.
    (count) => `runner: push ${count} pending operation${count === 1 ? "" : "s"}`,
  );
  for (const { path, reason } of outcome.refused) refused.push({ opId: opIdOf.get(path) ?? path, reason });
  return {
    listed: pending.length,
    commit: outcome.commit,
    written: outcome.written.map((path) => opIdOf.get(path)!),
    skipped: outcome.skipped.map((path) => opIdOf.get(path)!),
    refused,
    durationMs: elapsed(started),
  };
}

export interface RunnerLoopOptions {
  /** One pass, with whatever locking the caller needs. */
  readonly pass: () => Promise<RunnerPassResult>;
  /** The wait between the end of one pass and the start of the next. */
  readonly intervalMs: number;
  readonly onPass?: (result: RunnerPassResult) => void;
  /** A pass that threw, such as Penguin or the issues repo being unreachable. The loop carries on. */
  readonly onError?: (error: Error) => void;
}

/** Runs a pass now and again after each wait until stopped. Operations wait as pending meanwhile. */
export class RunnerLoop {
  readonly #options: RunnerLoopOptions;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  constructor(options: RunnerLoopOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  /** Stops the loop after any pass in progress finishes. */
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
    try {
      this.#options.onPass?.(await this.#options.pass());
    } catch (error) {
      this.#options.onError?.(error as Error);
    }
    this.#schedule(this.#options.intervalMs);
  }
}

export function formatPass(result: RunnerPassResult): string {
  const lines = result.refused.map(({ opId, reason }) => `Refused ${opId}: ${reason}`);
  const commit = result.commit === null ? "no commit" : `commit ${result.commit.slice(0, 12)}`;
  lines.push(
    `${result.listed} pending: ${result.written.length} pushed in ${commit}, ` +
      `${result.skipped.length} already in the repo, ${result.refused.length} refused (${result.durationMs} ms).`,
  );
  return `${lines.join("\n")}\n`;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
