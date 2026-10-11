// One write from the issue page: which action is sending, and why the last one failed. Every write
// reads the issue again afterwards, applied or rejected, so the page shows what the index holds.

import { useState } from "react";

import { SignedOut, type WriteOutcome } from "./api.ts";
import { reasonLabel } from "./issue-view.ts";

export interface Operation {
  /** The action being sent, such as "approve", or undefined while none is. */
  readonly sending: string | undefined;
  readonly problem: string | undefined;
  /** Sends `write` as `action` unless another action is sending; `onApplied` runs once it applies. */
  send(action: string, write: () => Promise<WriteOutcome>, onApplied?: () => void): void;
}

export function useOperation(onSignedOut: () => void, onWritten: () => void): Operation {
  const [sending, setSending] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const send = (action: string, write: () => Promise<WriteOutcome>, onApplied?: () => void) => {
    if (sending !== undefined) return;
    setSending(action);
    setProblem(undefined);
    write().then(
      (outcome) => {
        setSending(undefined);
        if (outcome.status === "applied") onApplied?.();
        else setProblem(`Rejected for ${reasonLabel(outcome.reason)}`);
        onWritten();
      },
      (error: unknown) => {
        setSending(undefined);
        if (error instanceof SignedOut) onSignedOut();
        else setProblem("Please try again");
      },
    );
  };

  return { sending, problem, send };
}
