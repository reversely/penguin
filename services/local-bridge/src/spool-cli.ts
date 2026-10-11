// The `penguin-bridge spool drain|watch` commands and the location of the bridge's spool.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { CliIo } from "./cli.ts";
import { Spool } from "./spool.ts";
import { drainSpool, RetryLoop, type DrainResult } from "./spool-drain.ts";

export const SPOOL_USAGE = `       penguin-bridge spool drain [--state-dir <dir>]
       penguin-bridge spool watch [--state-dir <dir>] [--interval <ms>]
`;

export function defaultStateDir(): string {
  return join(homedir(), ".penguin");
}

/** The bridge's one outbound spool, in its state folder. */
export function bridgeSpool(stateDir: string): Spool {
  return new Spool(join(resolve(stateDir), "spool.jsonl"));
}

/**
 * Runs `spool drain` (push what is queued once) or `spool watch` (keep draining, backing off
 * while the remote is unreachable, until interrupted). Resolves with the exit code.
 */
export async function runSpoolCommand(args: readonly string[], io: CliIo, stateDir: string): Promise<number> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { "state-dir": { type: "string" }, interval: { type: "string" } },
    strict: true,
  });
  const spool = bridgeSpool(values["state-dir"] ?? stateDir);
  if (command === "drain") {
    const result = await drainSpool(spool);
    io.write(formatDrain(result));
    return result.failed.length > 0 ? 1 : 0;
  }
  if (command === "watch") {
    const interval = Number(values.interval ?? "1000");
    if (!Number.isInteger(interval) || interval <= 0) {
      io.write(SPOOL_USAGE);
      return 2;
    }
    const loop = new RetryLoop({
      spool,
      minDelayMs: interval,
      idleDelayMs: interval,
      onDrain: (result) => {
        if (result.pushed.length + result.failed.length > 0) io.write(formatDrain(result));
      },
    });
    loop.start();
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    await loop.stop();
    return 0;
  }
  io.write(SPOOL_USAGE);
  return 2;
}

export function formatDrain(result: DrainResult): string {
  const lines = [
    ...result.pushed.map(({ id, commit }) => `Pushed ${id} in commit ${commit.slice(0, 12)}.`),
    ...result.failed.map(({ id, reason }) => `Failed ${id}: ${reason}`),
    ...result.waiting.map(({ id, reason }) => `Queued ${id}: ${reason}`),
    `${result.pushed.length} pushed, ${result.waiting.length} queued, ${result.failed.length} failed.`,
  ];
  return `${lines.join("\n")}\n`;
}
