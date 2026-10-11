// Verification runs of a Huddle (PRD sections 4, 6 and 12). Penguin schedules a run when a newer
// checkpoint of an owner in the Huddle arrives; the integration runner lists the scheduled runs,
// merges the listed checkpoints onto the Huddle repo's `integration` branch, pushes it, runs each
// listed command on the result and reports back. Like the combined-run event, a report carries each
// failing test and the result's fingerprint, never a test log.

import {
  COMBINED_RUN_LIMITS,
  parseCommitField,
  parseFailingTestList,
  parseFingerprintField,
  parseOwnerField,
  type CombinedRunFailingTest,
  type CombinedRunFingerprint,
  type CombinedRunIssue,
  type FieldReport,
} from "./combined-run.ts";
import { COMMAND_ID_PATTERN } from "./operation-schema.ts";

/** One owner's checkpoint to merge, in the owner's fork. */
export interface VerificationCheckpoint {
  readonly ownerId: string;
  /** The fork as a project repo name, `owner-<owner id>`. */
  readonly repo: string;
  readonly sha: string;
}

/** One allowlisted command to run on the integration result. */
export interface VerificationCommand {
  readonly scopeId: string;
  /** `test:<scope id>`. */
  readonly commandId: string;
}

/** A scheduled run as Penguin lists it to the runner. */
export interface VerificationRunSpec {
  readonly runId: string;
  /** The Huddle issue's number. */
  readonly issueId: string;
  /** The Huddle repo as a project repo name, `huddle-<id>`; the runner pushes `integration` there. */
  readonly huddleRepo: string;
  /** The commit the trigger was made from, where the integration result starts. */
  readonly baseSha: string;
  /** Merged onto the base in this order. */
  readonly checkpoints: readonly VerificationCheckpoint[];
  readonly commands: readonly VerificationCommand[];
}

/** One command's result on the integration revision. */
export interface VerificationResult {
  readonly commandId: string;
  readonly status: "passed" | "failed";
  readonly fingerprint: CombinedRunFingerprint;
  /** Empty for a pass, or for a failed run whose log names no test. */
  readonly failingTests: readonly CombinedRunFailingTest[];
}

/** The checkpoints merged cleanly, the result was pushed as `revision`, and every command ran on it. */
export interface TestedVerification {
  readonly status: "tested";
  /** The `integration` commit the runner pushed to the Huddle repo: the revision every check applies to. */
  readonly revision: string;
  readonly results: readonly VerificationResult[];
}

/** A checkpoint did not merge onto the others, so nothing was pushed and no command ran. */
export interface ConflictedVerification {
  readonly status: "conflict";
  readonly ownerId: string;
  /** The checkpoint that conflicted. */
  readonly sha: string;
  readonly paths: readonly string[];
}

export type VerificationReport = TestedVerification | ConflictedVerification;

export type VerificationReportParse =
  | { readonly ok: true; readonly report: VerificationReport }
  | { readonly ok: false; readonly issues: CombinedRunIssue[] };

/**
 * The Huddle repo's id for a Huddle issue: the issue number zero-padded to three digits, as in
 * `huddle-031` for #31.
 */
export function huddleRepoId(issueId: string): string {
  return issueId.padStart(3, "0");
}

/** The Huddle repo of a Huddle issue as a project repo name, such as `huddle-031`. */
export function huddleRepoName(issueId: string): string {
  return `huddle-${huddleRepoId(issueId)}`;
}

const COMMAND_ID = new RegExp(`^${COMMAND_ID_PATTERN}$`, "u");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a report from the network and returns a copy holding only the fields above. */
export function parseVerificationReport(value: unknown): VerificationReportParse {
  const issues: CombinedRunIssue[] = [];
  const report: FieldReport = (field, message) => {
    issues.push({ field, message });
  };
  if (!isRecord(value)) return { ok: false, issues: [{ field: "", message: "must be a JSON object" }] };
  if (value.status === "conflict") {
    const ownerId = parseOwnerField(value.ownerId, "ownerId", report);
    const sha = parseCommitField(value.sha, "sha", report);
    const paths = Array.isArray(value.paths) && value.paths.length <= COMBINED_RUN_LIMITS.unmappedPaths ? value.paths : undefined;
    const valid = paths?.every((path) => typeof path === "string" && path.length > 0 && path.length <= COMBINED_RUN_LIMITS.pathLength);
    if (!valid) report("paths", `must be an array of at most ${COMBINED_RUN_LIMITS.unmappedPaths} repository paths`);
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, report: { status: "conflict", ownerId: ownerId!, sha: sha!, paths: [...(paths as string[])] } };
  }
  if (value.status !== "tested") return { ok: false, issues: [{ field: "status", message: "must be tested or conflict" }] };

  const revision = parseCommitField(value.revision, "revision", report);
  const results: VerificationResult[] = [];
  if (!Array.isArray(value.results) || value.results.length === 0 || value.results.length > COMBINED_RUN_LIMITS.results) {
    report("results", `must be an array of 1 to ${COMBINED_RUN_LIMITS.results} results`);
  } else {
    value.results.forEach((raw: unknown, index) => {
      const parsed = result(raw, `results[${index}]`, report);
      if (parsed !== undefined) results.push(parsed);
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, report: { status: "tested", revision: revision!, results } };
}

function result(raw: unknown, at: string, report: FieldReport): VerificationResult | undefined {
  if (!isRecord(raw)) {
    report(at, "must be an object");
    return undefined;
  }
  let problems = 0;
  const fail: FieldReport = (field, message) => {
    problems += 1;
    report(field, message);
  };
  const commandId = typeof raw.commandId === "string" && raw.commandId.length <= 64 && COMMAND_ID.test(raw.commandId)
    ? raw.commandId
    : undefined;
  if (commandId === undefined) fail(`${at}.commandId`, "must be an allowlisted command ID");
  const status = raw.status === "passed" || raw.status === "failed" ? raw.status : undefined;
  if (status === undefined) fail(`${at}.status`, "must be passed or failed");
  const fingerprint = parseFingerprintField(raw.fingerprint, `${at}.fingerprint`, fail);
  const failingTests = parseFailingTestList(raw.failingTests, `${at}.failingTests`, fail);
  if (status === "passed" && failingTests.length > 0) fail(`${at}.failingTests`, "only a failed result lists failing tests");
  if (problems > 0) return undefined;
  return { commandId: commandId!, status: status!, fingerprint: fingerprint!, failingTests };
}
