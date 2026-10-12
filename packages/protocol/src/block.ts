// Landing a feature as a block (PRD 0.4 section 4.5) as it crosses the network: the block run the
// check runner claims, the report it sends back, how Penguin reads the report, and the promotion
// record of what reached main.
//
// A block run checks one feature's checkpoint merged onto main and onto each other running feature's
// fork head, where an approved fix of the feature's plan already sits (fix-write.ts). A `land` run
// promotes main when every check passes. An `expand` run checks the expand checkpoint of a split
// (PRD 4.2 step 2) the same way and promotes it on its own, leaving the feature's fork writable. A
// `plan_check` run checks the same block for an announced plan when another feature's checkpoint
// reaches the plan's area (PRD 4.4 step 3); it never promotes.
//
// Everything that reaches Git here is a full object ID or a branch name checked against
// BRANCH_PATTERN; nothing is interpolated into a shell string.

import { BLOCK_CHECK_LIMITS, BLOCK_CHECK_SCHEMA, MAIN_TARGET, type BlockCheck } from "./block-check.ts";
import { SEGMENT_PATTERN } from "./operation-schema.ts";
import type { CharterView, LadderDecision } from "./resolution.ts";
import { checkSchema, type JsonSchema } from "./schema-check.ts";
import { LADDER_DECISION_SCHEMA } from "./tool-result.ts";

export const BLOCK_SCHEMA_VERSION = 1;

/**
 * `land`: checks the block, then promotes main. `expand`: checks a checkpoint that only adds, then
 * promotes it alone while the feature keeps building. `plan_check`: checks an announced plan's block only.
 */
export const BLOCK_RUN_PURPOSES = ["land", "expand", "plan_check"] as const;
export type BlockRunPurpose = (typeof BLOCK_RUN_PURPOSES)[number];

export const BLOCK_LIMITS = {
  /** Fork targets in one run besides main: the running features. */
  targets: 128,
  summaryLength: 300,
  /** The JSON text of one report. A Durable Object row holds 2 MB. */
  reportBytes: 1_048_576,
} as const;

/** A full SHA-1 object ID, lowercase. */
export const OBJECT_ID = /^[0-9a-f]{40}$/u;

/**
 * A branch name Penguin will name in a Git ref: letters, digits, '.', '_', '/' and '-', starting
 * with a letter or digit, with no "..", no "//", no "@{" and no trailing "/" or ".lock".
 */
export const BRANCH_PATTERN = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export function isBranchName(value: unknown): value is string {
  return typeof value === "string" && BRANCH_PATTERN.test(value);
}

/** A run id: the feature id and the run's number in that feature's FeatureAgent, `<feature>/<n>`. */
export const BLOCK_RUN_ID = new RegExp(`^(${SEGMENT_PATTERN})/([1-9][0-9]{0,8})$`, "u");

export function blockRunId(featureId: string, seq: number): string {
  return `${featureId}/${seq}`;
}

/** The feature a run id names, or undefined for a malformed id. */
export function featureOfBlockRun(runId: unknown): string | undefined {
  if (typeof runId !== "string" || runId.length > 80) return undefined;
  return BLOCK_RUN_ID.exec(runId)?.[1];
}

/** One running feature's fork the checkpoint is merged onto. */
export interface BlockRunTarget {
  readonly feature: string;
  readonly person: string;
  /** `feature-<id>`, without the deployment's prefix. */
  readonly fork: string;
  /** The fork's head on its main branch: the feature's work with every fix written into it. */
  readonly sha: string;
}

/** What the check runner claims: one block to check. */
export interface BlockRunRequest {
  readonly runId: string;
  readonly feature: string;
  /** The feature's newest merge plan, or null for a feature with none. */
  readonly planId: string | null;
  readonly purpose: BlockRunPurpose;
  /** The originating feature's fork, which holds the checkpoint. */
  readonly fork: string;
  /** The commit main moves to when a land run passes. */
  readonly checkpoint: string;
  /** Main's head the block is checked against: `main_before` of the promotion. */
  readonly main: string;
  /** Main's branch in the base repo, from Penguin's BASE_BRANCH. */
  readonly branch: string;
  readonly targets: readonly BlockRunTarget[];
  /** The originating agent's charter, which the resolution ladder routes failures by. */
  readonly charter: CharterView;
}

/** What the check runner reports for one run. */
export interface BlockRunReport {
  readonly schemaVersion: typeof BLOCK_SCHEMA_VERSION;
  readonly runId: string;
  readonly checkpoint: string;
  readonly main: string;
  /** Every check on main and on each target's merged tree, tests included. */
  readonly checks: readonly BlockCheck[];
  /** One next step per failed or erred check, from the resolution ladder. */
  readonly decisions: readonly LadderDecision[];
  readonly summary: string;
  /** The runner's wall time for the fetches, merges, checks and tests. */
  readonly durationMs: number;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}$" };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** JSON Schema (draft 2020-12) of a block run's report as the runner sends it. */
export const BLOCK_RUN_REPORT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin block run report",
  ...object({
    schemaVersion: { const: BLOCK_SCHEMA_VERSION },
    runId: { type: "string", pattern: BLOCK_RUN_ID.source, maxLength: 80 },
    checkpoint: SHA,
    main: SHA,
    checks: { type: "array", maxItems: BLOCK_CHECK_LIMITS.checks, items: BLOCK_CHECK_SCHEMA },
    decisions: { type: "array", maxItems: BLOCK_CHECK_LIMITS.checks, items: LADDER_DECISION_SCHEMA },
    summary: { type: "string", maxLength: BLOCK_LIMITS.summaryLength },
    durationMs: { type: "integer", minimum: 0 },
  }),
};

export type ParsedBlockReport = { readonly ok: true; readonly report: BlockRunReport } | { readonly ok: false; readonly problems: string[] };

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? "").length;

/**
 * Checks a reported block run against the run it answers: its shape and size, the same run, the
 * same checkpoint and main, every check starting from the checkpoint, and every check's target one of
 * the run's targets at the commit the run named. A report that checks anything else is refused.
 */
export function parseBlockRunReport(value: unknown, request: BlockRunRequest): ParsedBlockReport {
  if (byteLength(value) > BLOCK_LIMITS.reportBytes) return { ok: false, problems: [`the report is over ${BLOCK_LIMITS.reportBytes} bytes of JSON`] };
  const errors = checkSchema(BLOCK_RUN_REPORT_SCHEMA, value);
  if (errors.length > 0) return { ok: false, problems: errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`) };
  const report = value as BlockRunReport;
  const problems: string[] = [];
  if (report.runId !== request.runId) problems.push(`/runId names ${report.runId}, not ${request.runId}`);
  if (report.checkpoint !== request.checkpoint) problems.push("/checkpoint is not the run's checkpoint");
  if (report.main !== request.main) problems.push("/main is not the run's main");
  const commits = new Map<string, string>([[MAIN_TARGET, request.main], ...request.targets.map((target) => [target.feature, target.sha] as const)]);
  for (const [index, check] of report.checks.entries()) {
    if (check.input.origin !== request.checkpoint) problems.push(`/checks/${index} starts from another commit than the checkpoint`);
    const commit = commits.get(check.target);
    if (commit === undefined) problems.push(`/checks/${index} names target ${check.target}, which the run does not`);
    else if (check.input.target !== commit) problems.push(`/checks/${index} checks ${check.target} at another commit than the run named`);
    if (check.planId !== request.planId) problems.push(`/checks/${index} names another plan than the run`);
  }
  for (const [index, decision] of report.decisions.entries()) {
    if (!commits.has(decision.target)) problems.push(`/decisions/${index} names target ${decision.target}, which the run does not`);
  }
  return problems.length > 0 ? { ok: false, problems: problems.slice(0, 10) } : { ok: true, report };
}

/** Whether a reported block passes, and why not. */
export interface BlockVerdict {
  readonly passed: boolean;
  /** The checks that failed or could not run. */
  readonly failing: readonly BlockCheck[];
  /** Targets with no passed merge check: a block is never promoted on a target nobody merged. */
  readonly unmerged: readonly string[];
  /** True when main's tests ran and passed on the merged tree. */
  readonly mainTested: boolean;
}

/**
 * A block passes when no check failed or erred, every target (main included) has a passed merge
 * check, and main's merged tree ran at least one test command with every one passing. `not-affected`
 * and `not-run` count as passing only where the merge passed: the impact graph showed no use.
 */
export function blockVerdict(request: BlockRunRequest, checks: readonly BlockCheck[]): BlockVerdict {
  const failing = checks.filter((check) => check.result === "failed" || check.result === "error");
  const merged = new Set(checks.filter((check) => check.check === "merge" && check.result === "passed").map((check) => check.target));
  const unmerged = [MAIN_TARGET, ...request.targets.map((target) => target.feature)].filter((target) => !merged.has(target));
  const mainTests = checks.filter((check) => check.target === MAIN_TARGET && check.check === "tests");
  const mainTested = mainTests.length > 0 && mainTests.every((check) => check.result === "passed");
  return { passed: failing.length === 0 && unmerged.length === 0 && mainTested, failing, unmerged, mainTested };
}

/** A fix of the plan written into an affected fork, as the promotion record names it. */
export interface PromotedFix {
  readonly partId: string;
  readonly revision: number;
  readonly targetRepo: string;
  readonly commitSha: string;
}

/**
 * What reached main (PRD 0.4 section 9, `Promotion(plan_id, main_before, main_after)`): main moved
 * from `mainBefore` to `mainAfter`, the originating feature's checkpoint, in one push, with every
 * affected fork already carrying its fix.
 */
export interface Promotion {
  readonly schemaVersion: typeof BLOCK_SCHEMA_VERSION;
  /** `expand` for an expand checkpoint promoted alone; absent for a feature's land. */
  readonly purpose?: "expand";
  readonly planId: string | null;
  readonly featureId: string;
  readonly runId: string;
  readonly branch: string;
  readonly mainBefore: string;
  readonly mainAfter: string;
  /** The block's targets at the commits the passing run checked. */
  readonly targets: readonly { readonly feature: string; readonly sha: string }[];
  readonly fixes: readonly PromotedFix[];
  /** The signed `block_checked` record of the passing run and the signed `promotion` record. */
  readonly checkRecordId: string;
  readonly recordId: string;
  readonly requestedAt: string;
  readonly promotedAt: string;
  /** From the land request to the runner's report. */
  readonly checkMs: number;
  /** From the passing report to main moved: tokens, fetch, push and revocation. */
  readonly promoteMs: number;
}
