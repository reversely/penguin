// Safe checkpoints for agent sessions (PRD section 4, Layer 2). Penguin hands a Huddle's fix task to
// a session only at the session's next safe checkpoint, so it never lands in the middle of other
// work. The bridge reports one for a worktree:
//
// - from the agent product's PreToolUse hook, before the agent's next tool action. Claude Code and
//   Codex both run a command hook in the session's working directory and add a JSON answer's
//   `hookSpecificOutput.additionalContext` to the model's context, which is how the agent hears
//   that a fix task arrived, that a thread now needs its developer, that another feature's start
//   waits for its developer's approval, that a lock on its own feature's start was approved or
//   withdrawn, or that the check runner answered one of its `impact`, `check` or `apply_fix` calls;
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

/** An open thread, by its issue and the op_id of the operation that opened it. */
export interface ThreadNotice {
  readonly issueId: string;
  readonly threadId: string;
}

/** A feature whose start waits for the developer's approval beside their running feature. */
export interface OverlapNotice {
  readonly feature: string;
  readonly blockedFeature: string;
}

/** A lock on the session's feature that was approved or withdrawn, so the feature may start. */
export interface SettledNotice extends OverlapNotice {
  readonly outcome: string;
}

/** The check runner's answer to one of the session's tool calls, by the id the call was recorded as. */
export interface ToolResultNotice {
  readonly recordedAs: number;
  readonly tool: string;
  readonly feature: string;
  readonly result: string;
  readonly summary: string;
}

/** A revision of a merge plan part that waits on the session's developer. */
export interface PlanPartNotice {
  readonly feature: string;
  readonly part: string;
  readonly revision: number;
  readonly scopes: readonly string[];
}

/** A decision on a part of the plan of the session's own feature. */
export interface PlanDecisionNotice {
  readonly feature: string;
  readonly part: string;
  readonly revision: number;
  readonly state: string;
}

/** The check runner's verdict on a review the session submitted. */
export interface ReviewResultNotice {
  readonly reviewId: number;
  readonly feature: string;
  readonly scope: string;
  readonly state: string;
  /** Refusal codes and exception kinds; their texts stay with Penguin's answer, never in the hook. */
  readonly refusals: readonly string[];
  readonly exceptions: readonly string[];
}

/**
 * One session's part of a safe checkpoint: the fix tasks Penguin delivered to it, the threads and
 * overlapping starts needing the session's developer, the settled locks on its own feature, and the
 * merge plan parts, decisions and review verdicts of advance notice, each heard of for the first time.
 */
export interface SessionDelivery {
  readonly sessionId: string;
  readonly identity: string;
  readonly delivered: readonly string[];
  readonly threads: readonly ThreadNotice[];
  readonly overlaps: readonly OverlapNotice[];
  readonly locksSettled: readonly SettledNotice[];
  readonly toolResults?: readonly ToolResultNotice[];
  readonly newPlanParts: readonly PlanPartNotice[];
  readonly planDecisions: readonly PlanDecisionNotice[];
  readonly reviewResults: readonly ReviewResultNotice[];
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
  return body.sessions.flatMap((value: unknown) => {
    const delivery = asDelivery(value);
    return delivery === undefined ? [] : [delivery];
  });
}

/**
 * A session's delivery from Penguin's answer, or undefined when malformed. A server without threads
 * or overlap locks sends none.
 */
function asDelivery(value: unknown): SessionDelivery | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const {
    sessionId,
    identity,
    delivered,
    threads = [],
    overlaps = [],
    locksSettled = [],
    toolResults = [],
    newPlanParts = [],
    planDecisions = [],
    reviewResults = [],
  } = value as Record<string, unknown>;
  const wellFormed =
    typeof sessionId === "string" &&
    typeof identity === "string" &&
    Array.isArray(delivered) &&
    delivered.every((issue) => typeof issue === "string") &&
    Array.isArray(threads) &&
    threads.every(isThreadNotice) &&
    Array.isArray(overlaps) &&
    overlaps.every(isOverlapNotice) &&
    Array.isArray(locksSettled) &&
    locksSettled.every((notice) => isOverlapNotice(notice) && typeof (notice as { outcome?: unknown }).outcome === "string") &&
    Array.isArray(toolResults) &&
    toolResults.every(isToolResultNotice) &&
    Array.isArray(newPlanParts) &&
    newPlanParts.every((notice) => isPartNotice(notice) && isStrings((notice as { scopes?: unknown }).scopes)) &&
    Array.isArray(planDecisions) &&
    planDecisions.every((notice) => isPartNotice(notice) && typeof (notice as { state?: unknown }).state === "string") &&
    Array.isArray(reviewResults) &&
    reviewResults.every(isReviewResult);
  if (!wellFormed) return undefined;
  return {
    sessionId,
    identity,
    delivered,
    threads,
    overlaps,
    locksSettled: locksSettled as SettledNotice[],
    toolResults: toolResults as ToolResultNotice[],
    newPlanParts: (newPlanParts as PlanPartNotice[]).map(({ feature, part, revision, scopes }) => ({ feature, part, revision, scopes })),
    planDecisions: (planDecisions as PlanDecisionNotice[]).map(({ feature, part, revision, state }) => ({ feature, part, revision, state })),
    reviewResults: (reviewResults as ReviewResultNotice[]).map(({ reviewId, feature, scope, state, refusals, exceptions }) => ({
      reviewId,
      feature,
      scope,
      state,
      refusals,
      exceptions,
    })),
  };
}

function isToolResultNotice(value: unknown): value is ToolResultNotice {
  if (typeof value !== "object" || value === null) return false;
  const { recordedAs, tool, feature, result, summary } = value as Record<string, unknown>;
  return Number.isSafeInteger(recordedAs) && [tool, feature, result, summary].every((field) => typeof field === "string");
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((each) => typeof each === "string");

function isPartNotice(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { feature, part, revision } = value as Record<string, unknown>;
  return typeof feature === "string" && typeof part === "string" && Number.isSafeInteger(revision);
}

function isReviewResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { reviewId, feature, scope, state, refusals, exceptions } = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(reviewId) &&
    typeof feature === "string" &&
    typeof scope === "string" &&
    typeof state === "string" &&
    isStrings(refusals) &&
    isStrings(exceptions)
  );
}

function isOverlapNotice(value: unknown): value is OverlapNotice {
  if (typeof value !== "object" || value === null) return false;
  const { feature, blockedFeature } = value as Record<string, unknown>;
  return typeof feature === "string" && typeof blockedFeature === "string";
}

function isThreadNotice(value: unknown): value is ThreadNotice {
  if (typeof value !== "object" || value === null) return false;
  const { issueId, threadId } = value as Record<string, unknown>;
  return typeof issueId === "string" && typeof threadId === "string";
}

/** One line per session for each of fix tasks, new threads and overlapping starts it received, or "". */
export function formatDeliveries(deliveries: readonly SessionDelivery[]): string {
  return deliveries
    .flatMap((delivery) => {
      const session = `${delivery.identity} (session ${delivery.sessionId})`;
      const lines: string[] = [];
      if (delivery.delivered.length > 0) {
        const issues = delivery.delivered.map((issue) => `#${issue}`).join(", ");
        const tasks = delivery.delivered.length === 1 ? "fix task" : "fix tasks";
        lines.push(`Penguin delivered ${tasks} ${issues} to ${session}.\n`);
      }
      if (delivery.threads.length > 0) {
        const issues = [...new Set(delivery.threads.map((thread) => `#${thread.issueId}`))].join(", ");
        const threads = delivery.threads.length === 1 ? "a thread" : `${delivery.threads.length} threads`;
        const need = delivery.threads.length === 1 ? "needs" : "need";
        lines.push(`Penguin: ${threads} on ${issues} now ${need} the developer of ${session}.\n`);
      }
      for (const { feature, blockedFeature } of delivery.overlaps) {
        lines.push(
          `Penguin: feature ${blockedFeature} waits for the developer of ${session} to approve its start beside feature ${feature}.\n`,
        );
      }
      for (const { feature, blockedFeature, outcome } of delivery.locksSettled) {
        lines.push(`Penguin: the lock of feature ${feature} on feature ${blockedFeature} was ${outcome} for ${session}.\n`);
      }
      for (const { recordedAs, tool, feature, result, summary } of delivery.toolResults ?? []) {
        lines.push(`Penguin: the check runner answered ${tool} ${recordedAs} on feature ${feature} for ${session}: ${result}, ${summary}.\n`);
      }
      for (const { feature, part, revision, scopes } of delivery.newPlanParts) {
        lines.push(
          `Penguin: revision ${revision} of part ${part} of feature ${feature}'s merge plan touches ${scopes.join(", ")} and waits on the developer of ${session}.\n`,
        );
      }
      for (const { part, revision, state } of delivery.planDecisions) {
        lines.push(`Penguin: revision ${revision} of part ${part} of the merge plan of ${session} is ${state.replaceAll("_", " ")}.\n`);
      }
      for (const { reviewId, feature, scope, state, refusals, exceptions } of delivery.reviewResults) {
        const why = refusals.length > 0 ? ` (${refusals.join(", ")})` : "";
        const raised = exceptions.length > 0 ? `; it raised ${exceptions.join(", ")} for the scope's owner` : "";
        lines.push(`Penguin: review ${reviewId} of ${scope} on feature ${feature} by ${session} was ${state}${why}${raised}.\n`);
      }
      return lines;
    })
    .join("");
}

/**
 * The PreToolUse hook answer that tells the agent about delivered fix tasks and threads that now need
 * its developer, or undefined when nothing arrived, so the hook prints nothing and the tool call goes
 * ahead unchanged.
 */
export function hookAnswer(deliveries: readonly SessionDelivery[]): string | undefined {
  const delivered = formatDeliveries(deliveries);
  if (delivered === "") return undefined;
  const threads = deliveries.some((delivery) => delivery.threads.length > 0)
    ? " Tell your developer about each thread in get_work's threadsNeedingYou."
    : "";
  const overlaps = deliveries.some((delivery) => delivery.overlaps.length > 0)
    ? " Tell your developer about each start in get_work's overlapsNeedingYou; they approve it on the dashboard's inbox."
    : "";
  const settled = deliveries.some((delivery) => delivery.locksSettled.length > 0)
    ? " Once get_work's feature.waitingOn is empty, call feature_token for the write token on your feature's fork."
    : "";
  const results = deliveries.some((delivery) => (delivery.toolResults ?? []).length > 0)
    ? " Read each tool result in get_work's toolResults under the id its call was recorded as."
    : "";
  const parts = deliveries.some((delivery) => delivery.newPlanParts.length > 0)
    ? " Review each part in get_work's planPartsNeedingYou with submit_review for its scopes and tell your developer, who approves it or asks for a change on the dashboard's inbox; you never approve it."
    : "";
  const decisions = deliveries.some((delivery) => delivery.planDecisions.some((decision) => decision.state === "change_requested"))
    ? " Answer each change_requested part in get_work's plan with revise_plan_part."
    : "";
  const reviews = deliveries.some((delivery) => delivery.reviewResults.length > 0)
    ? " get_work's reviewResults gives each verdict's reasons; fix a refused form and submit it again."
    : "";
  const additionalContext =
    `${delivered.trim().replaceAll("\n", " ")} Finish the step you are on, then call the penguin get_work tool with ` +
    `your sessionId to read each task's pinned base, allowed paths, failing tests and acceptance criteria.${threads}${overlaps}${settled}${results}${parts}${decisions}${reviews}`;
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
