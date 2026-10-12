// A runner pass that stops a run on an error reports the failure to Penguin (POST /runs/failures),
// which releases the run at once for any runner's next claim. A pass that succeeds sends nothing
// more. When the report itself cannot reach Penguin, the run keeps its claim until the lease ends.

import type { RunFailureOutcome, RunKind } from "@penguin/protocol";

/** Penguin's answer to a failure the runner reported: released for another try, or stopped. */
export type RunFailureReply = Exclude<RunFailureOutcome, { readonly status: "rejected" }>;

/** Reports one failed run, such as `reportRunFailure` bound to the bridge token. */
export type FailRun = (failure: { readonly kind: RunKind; readonly runId: string; readonly reason: string }) => Promise<RunFailureReply>;

/** What became of a stopped run: Penguin's answer, or why the failure was not reported. */
export type FailureNote = RunFailureReply | { readonly status: "unreported"; readonly error: string };

/** Reports the failure when the pass can; null when it has no way to report. Never throws. */
export async function noteFailure(fail: FailRun | undefined, kind: RunKind, runId: string, reason: string): Promise<FailureNote | null> {
  if (fail === undefined) return null;
  try {
    return await fail({ kind, runId, reason });
  } catch (error) {
    return { status: "unreported", error: (error as Error).message };
  }
}

/** What happens to a stopped run next, as the pass prints it. */
export function failureText(note: FailureNote | null): string {
  if (note === null || note.status === "unreported") {
    return `it runs again after its lease${note === null ? "" : ` (the failure was not reported: ${note.error})`}`;
  }
  if (note.status === "released") return `Penguin released it for any runner (failure ${note.failures} of ${note.limit})`;
  return `Penguin stopped it after ${note.failures} failures and routed it to ${note.personId}`;
}
