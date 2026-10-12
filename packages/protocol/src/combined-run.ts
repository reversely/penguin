// The typed event the integration runner sends Penguin after a combined run (PRD section 4, Layer 1):
// which published checkpoint triggered it, which scopes it changed, which changed paths fall in no
// scope, and each dependent scope's result. It carries each failing test and the result's
// fingerprint, never a test log or a diff: the evidence a Huddle issue attaches is the failing test
// result and its fingerprint only (PRD section 14, decision 2).

import { BLOCK_CHECK_LIMITS, checkBlockCheck, type BlockCheck } from "./block-check.ts";
import {
  COMMAND_ID_PATTERN,
  FINGERPRINT_PATTERN,
  PERSON_ID_MAX_LENGTH,
  PERSON_ID_PATTERN,
  SEGMENT_PATTERN,
} from "./operation-schema.ts";

// `not-affected`: the impact graph shows the target's checkpoint uses nothing the change touches,
// so the scope's tests did not run. The result still completes the target's claimed run.
export const COMBINED_RESULT_STATUSES = ["passed", "failed", "conflict", "no-checkpoint", "not-affected"] as const;
export type CombinedResultStatus = (typeof COMBINED_RESULT_STATUSES)[number];

/** Limits that keep one event small enough to hold in one SQL row and one issue body. */
export const COMBINED_RUN_LIMITS = {
  results: 64,
  failingTestsPerResult: 200,
  unmappedPaths: 500,
  pathLength: 1_024,
  testLength: 256,
  scopeIdLength: 128,
  targetLength: 63,
} as const;

export interface CombinedRunFailingTest {
  /** The pytest node ID, such as `analytics/tests/test_retention.py::test_dau_stable`. */
  readonly nodeId: string;
  /** The PRD's short form, such as `test_retention::dau_stable`. */
  readonly testId: string;
}

/** What a result applies to: the tested commit, its lockfiles and the command ID, hashed into `id`. */
export interface CombinedRunFingerprint {
  readonly id: string;
  readonly commit: string;
  readonly lockfileHash: string;
  readonly commandId: string;
}

export interface CombinedRunResult {
  /**
   * The merged tree the result is for: the id of the running feature whose fork's checkpoint was
   * merged with the trigger, or the person's id for their owner fork (`owner-<id>`). A person with
   * several running features has one target per feature (PRD 0.4 section 1). An event that leaves
   * it out means the owner fork, `ownerId`.
   */
  readonly target: string;
  /** The target's person: the dependent scope's owner, who is routed its failures. */
  readonly ownerId: string;
  readonly scopeId: string;
  /** The allowlisted command the runner ran, `test:<scope id>`. */
  readonly commandId: string;
  readonly status: CombinedResultStatus;
  /** The target's checkpoint, or null when the dependent scope's owner has published none. */
  readonly ownerCheckpoint: string | null;
  /** Present when tests ran: a passed or failed result. */
  readonly fingerprint: CombinedRunFingerprint | null;
  /** The tests the log names as failed; empty for a pass or a log without a pytest summary. */
  readonly failingTests: readonly CombinedRunFailingTest[];
}

export interface CombinedRunEvent {
  /** The published checkpoint the run tested: its owner, its commit and the commit it was made from. */
  readonly trigger: { readonly ownerId: string; readonly sha: string; readonly baselineSha: string };
  /** Scopes the checkpoint changes, from the scope map at the checkpoint. */
  readonly changedScopes: readonly string[];
  /** Changed paths that fall in no scope. */
  readonly unmapped: readonly string[];
  /** One result per dependent scope. */
  readonly results: readonly CombinedRunResult[];
  /** The section 5.1 checks on each merged tree; absent from a runner that ran tests only. */
  readonly checks?: readonly BlockCheck[];
}

export interface CombinedRunIssue {
  readonly field: string;
  readonly message: string;
}

export type CombinedRunParse =
  | { readonly ok: true; readonly event: CombinedRunEvent }
  | { readonly ok: false; readonly issues: CombinedRunIssue[] };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const FINGERPRINT = new RegExp(`^${FINGERPRINT_PATTERN}$`, "u");
const COMMAND_ID = new RegExp(`^${COMMAND_ID_PATTERN}$`, "u");
const PERSON = new RegExp(PERSON_ID_PATTERN, "u");
const TARGET = new RegExp(`^${SEGMENT_PATTERN}$`, "u");
const STATUSES: ReadonlySet<string> = new Set(COMBINED_RESULT_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks an event from the network and returns a copy holding only the fields above. */
export function parseCombinedRunEvent(value: unknown): CombinedRunParse {
  const issues: CombinedRunIssue[] = [];
  const report = (field: string, message: string): void => {
    issues.push({ field, message });
  };
  if (!isRecord(value)) return { ok: false, issues: [{ field: "", message: "must be a JSON object" }] };

  const trigger = isRecord(value.trigger) ? value.trigger : undefined;
  if (trigger === undefined) report("trigger", "must be an object with ownerId, sha and baselineSha");
  const ownerId = person(trigger?.ownerId, "trigger.ownerId", report);
  const sha = commit(trigger?.sha, "trigger.sha", report);
  const baselineSha = commit(trigger?.baselineSha, "trigger.baselineSha", report);

  const changedScopes = strings(value.changedScopes, "changedScopes", COMBINED_RUN_LIMITS.results, report, scopeId);
  const unmapped = strings(value.unmapped, "unmapped", COMBINED_RUN_LIMITS.unmappedPaths, report, (path) =>
    path.length > 0 && path.length <= COMBINED_RUN_LIMITS.pathLength ? undefined : "must be a repository path",
  );

  const results: CombinedRunResult[] = [];
  if (!Array.isArray(value.results) || value.results.length > COMBINED_RUN_LIMITS.results) {
    report("results", `must be an array of at most ${COMBINED_RUN_LIMITS.results} results`);
  } else {
    value.results.forEach((raw: unknown, index) => {
      const parsed = result(raw, `results[${index}]`, report);
      if (parsed !== undefined) results.push(parsed);
    });
  }

  const checks = blockChecks(value.checks, report);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    event: {
      trigger: { ownerId: ownerId as string, sha: sha as string, baselineSha: baselineSha as string },
      changedScopes,
      unmapped,
      results,
      ...(value.checks === undefined ? {} : { checks }),
    },
  };
}

/** Checks the event's `checks`: absent, or an array of block checks. */
function blockChecks(raw: unknown, report: Report): BlockCheck[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > BLOCK_CHECK_LIMITS.checks) {
    report("checks", `must be an array of at most ${BLOCK_CHECK_LIMITS.checks} checks`);
    return [];
  }
  const checks: BlockCheck[] = [];
  raw.forEach((check: unknown, index) => {
    const [first] = checkBlockCheck(check);
    if (first === undefined) checks.push(check as BlockCheck);
    else report(`checks[${index}]${first.path.replaceAll("/", ".")}`, first.message);
  });
  return checks;
}

/** Records one problem with a field of a value from the network. */
export type FieldReport = (field: string, message: string) => void;
type Report = FieldReport;

function result(raw: unknown, at: string, report: Report): CombinedRunResult | undefined {
  if (!isRecord(raw)) {
    report(at, "must be an object");
    return undefined;
  }
  let valid = true;
  const fail: Report = (field, message) => {
    valid = false;
    report(field, message);
  };
  const ownerId = person(raw.ownerId, `${at}.ownerId`, fail);
  const target = raw.target === undefined ? ownerId : targetId(raw.target, `${at}.target`, fail);
  const scope = typeof raw.scopeId === "string" && scopeId(raw.scopeId) === undefined ? raw.scopeId : undefined;
  if (scope === undefined) fail(`${at}.scopeId`, "must be a scope id");
  const commandId = typeof raw.commandId === "string" && COMMAND_ID.test(raw.commandId) ? raw.commandId : undefined;
  if (commandId === undefined || commandId.length > 64) fail(`${at}.commandId`, "must be an allowlisted command ID");
  const status = typeof raw.status === "string" && STATUSES.has(raw.status) ? (raw.status as CombinedResultStatus) : undefined;
  if (status === undefined) fail(`${at}.status`, `must be one of ${COMBINED_RESULT_STATUSES.join(", ")}`);
  const ownerCheckpoint = raw.ownerCheckpoint === null || raw.ownerCheckpoint === undefined
    ? null
    : commit(raw.ownerCheckpoint, `${at}.ownerCheckpoint`, fail);
  const fingerprint = raw.fingerprint === null || raw.fingerprint === undefined
    ? null
    : parseFingerprintField(raw.fingerprint, `${at}.fingerprint`, fail);
  const tested = status === "passed" || status === "failed";
  if (tested && (fingerprint === null || ownerCheckpoint === null)) {
    fail(at, "a passed or failed result must carry its ownerCheckpoint and fingerprint");
  }
  if (status === "not-affected" && (ownerCheckpoint === null || fingerprint !== null)) {
    fail(at, "a not-affected result carries its ownerCheckpoint and no fingerprint");
  }
  const failingTests = parseFailingTestList(raw.failingTests, `${at}.failingTests`, fail);
  if (status !== "failed" && failingTests.length > 0) fail(`${at}.failingTests`, "only a failed result lists failing tests");
  if (!valid) return undefined;
  return {
    target: target as string,
    ownerId: ownerId as string,
    scopeId: scope as string,
    commandId: commandId as string,
    status: status as CombinedResultStatus,
    ownerCheckpoint: ownerCheckpoint ?? null,
    fingerprint: fingerprint ?? null,
    failingTests,
  };
}

/** Checks a result's `failingTests`: absent, or an array of `{ nodeId, testId }`. */
export function parseFailingTestList(raw: unknown, field: string, report: FieldReport): CombinedRunFailingTest[] {
  const failingTests: CombinedRunFailingTest[] = [];
  const rawTests = raw ?? [];
  if (!Array.isArray(rawTests) || rawTests.length > COMBINED_RUN_LIMITS.failingTestsPerResult) {
    report(field, `must be an array of at most ${COMBINED_RUN_LIMITS.failingTestsPerResult} tests`);
    return failingTests;
  }
  rawTests.forEach((test: unknown, index) => {
    const nodeId = isRecord(test) ? test.nodeId : undefined;
    const testId = isRecord(test) ? test.testId : undefined;
    if (!testText(nodeId) || !testText(testId)) report(`${field}[${index}]`, "must hold a nodeId and a testId");
    else failingTests.push({ nodeId, testId });
  });
  return failingTests;
}

function testText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= COMBINED_RUN_LIMITS.testLength;
}

function scopeId(value: string): string | undefined {
  return value.trim().length > 0 && value.length <= COMBINED_RUN_LIMITS.scopeIdLength ? undefined : "must be a scope id";
}

function person(value: unknown, field: string, report: Report): string | undefined {
  if (typeof value === "string" && value.length <= PERSON_ID_MAX_LENGTH && PERSON.test(value)) return value;
  report(field, "must be an owner id");
  return undefined;
}

function targetId(value: unknown, field: string, report: Report): string | undefined {
  if (typeof value === "string" && value.length <= COMBINED_RUN_LIMITS.targetLength && TARGET.test(value)) return value;
  report(field, "must be a feature id or an owner id");
  return undefined;
}

function commit(value: unknown, field: string, report: Report): string | undefined {
  if (typeof value === "string" && SHA.test(value)) return value;
  report(field, "must be a full lowercase commit SHA");
  return undefined;
}

/** Checks a result's fingerprint: its id, tested commit, lockfile hash and command ID. */
export function parseFingerprintField(
  value: unknown,
  field: string,
  report: FieldReport,
): CombinedRunFingerprint | undefined {
  if (!isRecord(value)) {
    report(field, "must be an object with id, commit, lockfileHash and commandId");
    return undefined;
  }
  const { id, lockfileHash, commandId } = value;
  const tested = commit(value.commit, `${field}.commit`, report);
  const idOk = typeof id === "string" && FINGERPRINT.test(id);
  const lockOk = typeof lockfileHash === "string" && FINGERPRINT.test(lockfileHash);
  const commandOk = typeof commandId === "string" && COMMAND_ID.test(commandId);
  if (!idOk) report(`${field}.id`, "must be a SHA-256 in lowercase hexadecimal");
  if (!lockOk) report(`${field}.lockfileHash`, "must be a SHA-256 in lowercase hexadecimal");
  if (!commandOk) report(`${field}.commandId`, "must be an allowlisted command ID");
  if (tested === undefined || !idOk || !lockOk || !commandOk) return undefined;
  return { id: id as string, commit: tested, lockfileHash: lockfileHash as string, commandId: commandId as string };
}

function strings(
  value: unknown,
  field: string,
  max: number,
  report: Report,
  check: (item: string) => string | undefined,
): string[] {
  if (!Array.isArray(value) || value.length > max) {
    report(field, `must be an array of at most ${max} strings`);
    return [];
  }
  const items: string[] = [];
  value.forEach((item: unknown, index) => {
    const problem = typeof item === "string" ? check(item) : "must be a string";
    if (problem === undefined) items.push(item as string);
    else report(`${field}[${index}]`, problem);
  });
  return items;
}

/** Field checks other events from the runner share: a full commit SHA and an owner id. */
export { commit as parseCommitField, person as parseOwnerField };
