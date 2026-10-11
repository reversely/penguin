// Telling Penguin about a checkpoint the bridge pushed to the owner's Artifacts fork, so the fork's
// latest checkpoint is recorded with no agent session running. A report waits in the spool while
// Penguin is unreachable and is sent by the next drain.

import { penguinRepoOf, RemoteUnavailableError } from "./git-remote.ts";
import type { KeyStore } from "./key-store.ts";
import { checkedOrigin, openBridge, type Fetch } from "./penguin-client.ts";
import type { CheckpointEntry, CheckpointReportEntry } from "./spool.ts";

/** The route that records a checkpoint the bridge pushed. */
export const CHECKPOINT_ROUTE = "/checkpoints";

export type CheckpointReportResult =
  | { readonly status: "reported" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly reason: string };

export type CheckpointReporter = (entry: CheckpointReportEntry) => Promise<CheckpointReportResult>;

/** A reporter for a bridge with no registration: reports stay queued with a reason. */
export const unregisteredReporter: CheckpointReporter = async () => ({
  status: "waiting",
  reason: "this bridge is not registered; run `penguin-bridge register`",
});

/**
 * The report a pushed checkpoint entry calls for, or undefined when its fork is not in Artifacts.
 * A local fork (Phase 1) has no Penguin to report to.
 */
export function checkpointReportFor(
  entry: CheckpointEntry,
): Omit<CheckpointReportEntry, "v" | "queued_at"> | undefined {
  if (penguinRepoOf(entry.fork) === undefined) return undefined;
  return { kind: "checkpoint-report", id: checkpointReportId(entry.id), fork: entry.fork, sha: entry.sha };
}

/** The spool ID of the report for the checkpoint entry `checkpointId`. */
export function checkpointReportId(checkpointId: string): string {
  return `report-${checkpointId}`;
}

/**
 * Sends one report to Penguin's checkpoint route. Penguin takes the owner from the bridge token and
 * refuses a fork that is not that owner's.
 */
export async function sendCheckpointReport(
  server: string,
  bridgeToken: string,
  entry: CheckpointReportEntry,
  fetchImpl: Fetch = fetch,
): Promise<CheckpointReportResult> {
  const origin = checkedOrigin(server, "the Penguin server").origin;
  const fork = penguinRepoOf(entry.fork);
  if (fork === undefined) return { status: "failed", reason: `${entry.fork} is not a fork in Artifacts` };
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${CHECKPOINT_ROUTE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sha: entry.sha, fork }),
    });
  } catch (error) {
    return { status: "waiting", reason: `Penguin at ${origin} is unreachable: ${(error as Error).message}` };
  }
  if (response.status === 200) return { status: "reported" };
  if (response.status === 401) {
    return { status: "waiting", reason: "Penguin refused the bridge token; register the bridge again" };
  }
  if (response.status === 400 || response.status === 403 || response.status === 422) {
    const { message } = (await response.json().catch(() => ({}))) as { message?: unknown };
    const detail = typeof message === "string" ? message.slice(0, 200) : `HTTP ${response.status}`;
    return { status: "failed", reason: `Penguin refused the checkpoint report: ${detail}` };
  }
  return { status: "waiting", reason: `Penguin could not record the checkpoint (HTTP ${response.status})` };
}

/**
 * The reporter a bridge command uses: the registration in `stateDir` and the bridge token in
 * `keyStore`, read for each report so a bridge registered after the report was queued can send it.
 */
export function bridgeReporter(stateDir: string, keyStore: KeyStore, fetchImpl?: Fetch): CheckpointReporter {
  return async (entry) => {
    let bridge: Awaited<ReturnType<typeof openBridge>>;
    try {
      bridge = await openBridge(stateDir, keyStore);
    } catch (error) {
      if (error instanceof RemoteUnavailableError) return { status: "waiting", reason: error.message };
      throw error;
    }
    return sendCheckpointReport(bridge.registration.server, bridge.bridgeToken, entry, fetchImpl);
  };
}
