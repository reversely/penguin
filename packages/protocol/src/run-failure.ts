// A check runner's report that it failed a run it claimed (POST /runs/failures). A runner whose pass
// stops on an error, such as a fetch that failed, reports the run and the reason. Penguin releases
// the claim at once, so any runner may take the run again on its next claim. After the project's
// failure limit (3 by default) Penguin stops handing the run out and routes it to the feature's
// person as an exception with the last reason. A runner that dies without reporting still loses its
// claim when the lease ends.

/** The kinds of run a check runner claims or lists, one per bridge route. */
export const RUN_KINDS = ["combined", "review", "tool", "plan-facts", "fix-write", "block", "part-trial"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** How many failures of one run Penguin takes before it stops handing the run out. */
export const RUN_FAILURE_LIMIT_DEFAULT = 3;

/** The longest reason Penguin keeps; a longer one is cut. */
export const RUN_FAILURE_REASON_LENGTH = 300;

/** What the runner sends: the run's kind, its id as that kind's route names it, and why it stopped. */
export interface RunFailureReport {
  readonly kind: RunKind;
  readonly runId: string;
  readonly reason: string;
}

/** Penguin's answer to a failure report. */
export type RunFailureOutcome =
  /** The claim is released; the run waits for the next claim of any runner. */
  | { readonly status: "released"; readonly kind: RunKind; readonly runId: string; readonly failures: number; readonly limit: number }
  /** The run reached the limit: it is no longer handed out and its feature's person has the exception. */
  | { readonly status: "stopped"; readonly kind: RunKind; readonly runId: string; readonly failures: number; readonly limit: number; readonly personId: string }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "not_found" | "conflict"; readonly message: string };

// A run id as the routes name it: a number, `run_<uuid>` for a combined run, `<feature>/<n>` for a block.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/[1-9][0-9]{0,8})?$/u;

/** The report in `value`, with its reason cut to RUN_FAILURE_REASON_LENGTH, or what is wrong with it. */
export function parseRunFailure(value: unknown): { readonly ok: true; readonly failure: RunFailureReport } | { readonly ok: false; readonly problems: readonly string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, problems: ["the body must be a JSON object"] };
  const { kind, runId, reason, ...rest } = value as Record<string, unknown>;
  const problems: string[] = [];
  if (Object.keys(rest).length > 0) problems.push(`unknown fields: ${Object.keys(rest).join(", ")}`);
  if (typeof kind !== "string" || !(RUN_KINDS as readonly string[]).includes(kind)) problems.push(`kind must be one of ${RUN_KINDS.join(", ")}`);
  if (typeof runId !== "string" || !RUN_ID.test(runId)) problems.push("runId must be a run id as its claim names it");
  if (typeof reason !== "string" || reason.trim() === "") problems.push("reason must say why the run stopped");
  if (problems.length > 0) return { ok: false, problems };
  const text = (reason as string).trim().replace(/\s+/gu, " ");
  const cut = text.length <= RUN_FAILURE_REASON_LENGTH ? text : `${text.slice(0, RUN_FAILURE_REASON_LENGTH - 3)}...`;
  return { ok: true, failure: { kind: kind as RunKind, runId: runId as string, reason: cut } };
}

/**
 * The failure limit from PENGUIN_RUN_FAILURE_LIMIT: a whole number from 1 to 20, or the default when
 * unset. Undefined for any other value, which the caller reports as a misconfiguration.
 */
export function parseRunFailureLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return RUN_FAILURE_LIMIT_DEFAULT;
  if (!/^[1-9][0-9]?$/u.test(value)) return undefined;
  const limit = Number(value);
  return limit <= 20 ? limit : undefined;
}
