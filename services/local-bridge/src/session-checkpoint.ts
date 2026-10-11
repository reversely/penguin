// Safe checkpoints for agent sessions (PRD section 4, Layer 2). Penguin hands a Huddle's fix task to
// a session only at the session's next safe checkpoint, so it never lands in the middle of other
// work. The bridge reports one for a worktree:
//
// - from the agent product's PreToolUse hook, before the agent's next tool action. Claude Code and
//   Codex both run a command hook in the session's working directory and add a JSON answer's
//   `hookSpecificOutput.additionalContext` to the model's context, which is how the agent hears
//   that a fix task arrived;
// - as an explicit bridge checkpoint, by hand or after `penguin-bridge checkpoint` publishes.
//
// Penguin knows the session by the worktree id it registered with, which `penguin-bridge
// worktree-id` prints for the current worktree.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import type { CliIo } from "./cli.ts";
import { RemoteRefusedError, RemoteUnavailableError } from "./git-remote.ts";
import type { KeyStore } from "./key-store.ts";
import { checkedOrigin, openBridge, type Fetch } from "./penguin-client.ts";
import { worktreeId } from "./registry.ts";

/** The route that takes a safe checkpoint of the owner's sessions in one worktree. */
export const SESSION_CHECKPOINT_ROUTE = "/sessions/checkpoint";

/**
 * The bridge id one-shot commands use. It only salts the worktree path's hash, so every one-shot
 * command on one machine gives a worktree the same id.
 */
export const LOCAL_BRIDGE_ID = "local";

export const SESSION_CHECKPOINT_USAGE = `       penguin-bridge session-checkpoint [--worktree <path>] [--hook] [--state-dir <dir>]
       penguin-bridge worktree-id [--worktree <path>]
`;

/** One session's part of a safe checkpoint: the fix tasks Penguin delivered to it. */
export interface SessionDelivery {
  readonly sessionId: string;
  readonly identity: string;
  readonly delivered: readonly string[];
}

/** The worktree that holds `path`, and the id sessions in it register with. */
export async function worktreeAt(path: string): Promise<{ readonly root: string; readonly id: string }> {
  const root = (await runGit(resolve(path), ["rev-parse", "--show-toplevel"])).trim();
  return { root, id: worktreeId(LOCAL_BRIDGE_ID, root) };
}

/** Sends a safe checkpoint of the worktree `id` to Penguin and returns what each session received. */
export async function sendSessionCheckpoint(
  server: string,
  bridgeToken: string,
  id: string,
  fetchImpl: Fetch = fetch,
): Promise<SessionDelivery[]> {
  const origin = checkedOrigin(server, "the Penguin server").origin;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${SESSION_CHECKPOINT_ROUTE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeId: id }),
    });
  } catch (error) {
    throw new RemoteUnavailableError(`Penguin at ${origin} is unreachable: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as { sessions?: unknown; message?: unknown };
  if (response.status === 401) throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
  if (response.status === 400) throw new RemoteRefusedError(`Penguin refused the safe checkpoint for ${id}`);
  if (response.status !== 200 || !Array.isArray(body.sessions)) {
    throw new RemoteUnavailableError(`Penguin could not take the safe checkpoint (HTTP ${response.status})`);
  }
  return body.sessions.filter(isDelivery);
}

function isDelivery(value: unknown): value is SessionDelivery {
  if (typeof value !== "object" || value === null) return false;
  const { sessionId, identity, delivered } = value as Record<string, unknown>;
  return (
    typeof sessionId === "string" &&
    typeof identity === "string" &&
    Array.isArray(delivered) &&
    delivered.every((issue) => typeof issue === "string")
  );
}

/** One line per session that received fix tasks, or "" when none did. */
export function formatDeliveries(deliveries: readonly SessionDelivery[]): string {
  return deliveries
    .filter((delivery) => delivery.delivered.length > 0)
    .map((delivery) => {
      const issues = delivery.delivered.map((issue) => `#${issue}`).join(", ");
      const tasks = delivery.delivered.length === 1 ? "fix task" : "fix tasks";
      return `Penguin delivered ${tasks} ${issues} to ${delivery.identity} (session ${delivery.sessionId}).\n`;
    })
    .join("");
}

/**
 * The PreToolUse hook answer that tells the agent about delivered fix tasks, or undefined when none
 * arrived, so the hook prints nothing and the tool call goes ahead unchanged.
 */
export function hookAnswer(deliveries: readonly SessionDelivery[]): string | undefined {
  const delivered = formatDeliveries(deliveries);
  if (delivered === "") return undefined;
  const additionalContext =
    `${delivered.trim()} Finish the step you are on, then call the penguin get_work tool with your ` +
    "sessionId to read each task's pinned base, allowed paths, failing tests and acceptance criteria.";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } })}\n`;
}

/**
 * Runs `session-checkpoint`. With --hook it is a PreToolUse command hook: it prints the hook answer
 * only when a fix task arrived and always exits 0, so an unreachable Penguin never stops the agent's
 * tool call. Without --hook it prints what happened and exits 1 when Penguin could not be told.
 */
export async function runSessionCheckpointCommand(
  args: readonly string[],
  io: CliIo,
  keyStore: KeyStore,
  defaultStateDir: string,
  fetchImpl?: Fetch,
): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      worktree: { type: "string", default: process.cwd() },
      hook: { type: "boolean", default: false },
      "state-dir": { type: "string" },
    },
    strict: true,
  });
  let deliveries: SessionDelivery[];
  let id: string;
  try {
    ({ id } = await worktreeAt(values.worktree));
    const { registration, bridgeToken } = await openBridge(values["state-dir"] ?? defaultStateDir, keyStore);
    deliveries = await sendSessionCheckpoint(registration.server, bridgeToken, id, fetchImpl);
  } catch (error) {
    if (values.hook) return 0;
    io.write(`Penguin did not take the safe checkpoint: ${(error as Error).message}\n`);
    return 1;
  }
  if (values.hook) {
    const answer = hookAnswer(deliveries);
    if (answer !== undefined) io.write(answer);
    return 0;
  }
  if (deliveries.length === 0) io.write(`No running session of yours is registered with worktree id ${id}.\n`);
  else io.write(formatDeliveries(deliveries) || `No fix task was waiting for the sessions in worktree ${id}.\n`);
  return 0;
}

/** Runs `worktree-id`: prints the id a session in this worktree registers with. */
export async function runWorktreeIdCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { worktree: { type: "string", default: process.cwd() } },
    strict: true,
  });
  io.write(`${(await worktreeAt(values.worktree)).id}\n`);
  return 0;
}

/**
 * After `penguin-bridge checkpoint` publishes, tells Penguin the worktree is at a safe checkpoint and
 * returns what to print: the delivered fix tasks, a reason it could not, or "" when nothing arrived.
 */
export async function afterPublish(
  stateDir: string,
  keyStore: KeyStore,
  id: string,
  fetchImpl?: Fetch,
): Promise<string> {
  try {
    const { registration, bridgeToken } = await openBridge(stateDir, keyStore);
    return formatDeliveries(await sendSessionCheckpoint(registration.server, bridgeToken, id, fetchImpl));
  } catch (error) {
    if (!(error instanceof RemoteUnavailableError || error instanceof RemoteRefusedError)) throw error;
    return `Penguin did not take the safe checkpoint: ${error.message}\n`;
  }
}
