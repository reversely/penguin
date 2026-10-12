// What the check runner reports for one agent tool request (`impact`, `check` or `apply_fix`, PRD
// 0.4 section 5.2). The ProjectAgent records the request; runner mode claims it, runs the tool on the
// feature's fork and reports this result, which reaches the requesting session at its next safe
// checkpoint.
//
// `impact` carries the impact graph and contract diff of the checkpoint against its baseline, with
// each other running feature's fork. `check` carries the block checks of the checkpoint merged onto
// main and onto each of those forks, with one ladder decision per failing check. `apply_fix` carries
// the fix's tool run. The runner gets a write token on a feature's fork only for an approved
// mechanical plan part (fix-write.ts), so an `apply_fix` commit stays a local ref on the runner and is
// never pushed: `pushed` is always false.

import { BLOCK_CHECK_LIMITS, BLOCK_CHECK_NAMES, BLOCK_CHECK_SCHEMA, type BlockCheck } from "./block-check.ts";
import { IMPACT_REPORT_SCHEMA, type ImpactReport } from "./impact.ts";
import { MIGRATION_REWRITES_SCHEMA, type MigrationRewritePlace } from "./migration.ts";
import type { MigrationGroup } from "./retiring.ts";
import { AGENT_TOOLS, FAILURE_KINDS, FIX_KINDS, type AgentToolName, type LadderDecision, type ToolRunRecord } from "./resolution.ts";
import { checkSchema, type JsonSchema } from "./schema-check.ts";

export const TOOL_RESULT_SCHEMA_VERSION = 1;

/** The tools the check runner runs; `whats_near` is answered by the ProjectAgent itself. */
export const RUNNER_TOOLS = ["impact", "check", "apply_fix"] as const satisfies readonly AgentToolName[];
export type RunnerToolName = (typeof RUNNER_TOOLS)[number];

export const TOOL_RESULT_LIMITS = {
  /** The JSON text of one result. A Durable Object row holds 2 MB. */
  resultBytes: 1_048_576,
  summaryLength: 300,
} as const;

/** One tool request's result as the runner reports it. Fields of the other tools are null or empty. */
export interface AgentToolResult {
  readonly schemaVersion: typeof TOOL_RESULT_SCHEMA_VERSION;
  readonly tool: RunnerToolName;
  /** The checkpoint's baseline on main. */
  readonly base: string;
  /** The feature's checkpoint the request was recorded at. */
  readonly checkpoint: string;
  /** `found` for impact and check, the fix's own result for apply_fix, `error` when the tool failed. */
  readonly result: "found" | "changed" | "unchanged" | "refused" | "error";
  /** One line that says what the tool found or changed. */
  readonly summary: string;
  readonly impact: ImpactReport | null;
  readonly checks: readonly BlockCheck[];
  /**
   * One next step per failed or erred check. An `impact` result that searched for retiring symbols
   * carries one `retiring` step per file and symbol the checkpoint's own changes use (retiring.ts).
   */
  readonly decisions: readonly LadderDecision[];
  /**
   * For an `impact` request that searched for retiring symbols across the running features: the
   * remaining callers on main and in their own changes, grouped by owner. Absent otherwise.
   */
  readonly migration?: { readonly groups: readonly MigrationGroup[]; readonly unowned: number };
  /**
   * For Penguin's rewrite request of a split's migration parts (migration.ts): each place's rewrite by
   * the declared rules, with its patch and the uses left. Absent otherwise.
   */
  readonly rewrites?: readonly MigrationRewritePlace[];
  readonly fix: ToolRunRecord | null;
  /** The runner's ref that keeps the fix commit, such as `refs/penguin/fixes/<commit>`; null without one. */
  readonly fixRef: string | null;
  /** Always false: only an approved plan part's fix is pushed, through fix-write.ts. */
  readonly pushed: false;
  readonly durationMs: number;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const text = (maxLength: number, minLength = 0): JsonSchema => ({ type: "string", minLength, maxLength });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const list = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", maxItems, items });
const MS = { type: "number", minimum: 0 };
const FINDING = object({
  path: nullable(text(BLOCK_CHECK_LIMITS.pathLength, 1)),
  line: nullable({ type: "integer", minimum: 0 }),
  code: nullable(text(128, 1)),
  message: text(BLOCK_CHECK_LIMITS.messageLength),
});
const FINDINGS = list(FINDING, BLOCK_CHECK_LIMITS.findingsPerCheck);

/** JSON Schema of one ladder decision, as a `check` result or a block run report carries it. */
export const LADDER_DECISION_SCHEMA = object({
  target: text(64, 1),
  check: { type: "string", enum: [...BLOCK_CHECK_NAMES] },
  failure: { type: "string", enum: [...FAILURE_KINDS] },
  step: { type: "integer", minimum: 1, maximum: 6 },
  nextStep: text(300),
  actor: object({ kind: { type: "string", enum: ["penguin", "originating-agent", "owner-agent", "person"] }, id: text(256, 1) }),
  fix: nullable(object({ kind: { type: "string", enum: [...FIX_KINDS] }, commandId: text(64, 1) })),
  reason: text(4_096),
  evidence: object({ summary: text(BLOCK_CHECK_LIMITS.messageLength), findings: FINDINGS }),
});

const TOOL_RUN = object({
  id: text(128, 1),
  tool: { type: "string", enum: [...AGENT_TOOLS] },
  caller: { type: "string", pattern: "^(?:penguin|@.+)$", maxLength: 256 },
  commandId: nullable(text(64, 1)),
  input: { type: "object" },
  result: { type: "string", enum: ["found", "changed", "unchanged", "refused", "error", "waiting"] },
  summary: text(4_096),
  findings: FINDINGS,
  changed: nullable(object({ before: SHA, after: SHA, paths: list(text(BLOCK_CHECK_LIMITS.pathLength, 1), 2_000) })),
  durationMs: MS,
});

const USE = object({
  path: text(BLOCK_CHECK_LIMITS.pathLength, 1),
  line: { type: "integer", minimum: 1 },
  kind: { type: "string", enum: ["import", "call", "reference"] },
  symbol: text(1_024, 1),
  name: text(1_024, 1),
  scope: nullable(text(128, 1)),
});
const PLACE = {
  anyOf: [object({ kind: { const: "scope" }, scope: text(128, 1) }), object({ kind: { const: "feature" }, feature: text(128, 1) })],
};
const MIGRATION = object({
  groups: list(object({ owner: text(128, 1), places: list(object({ place: PLACE, uses: list(USE, 2_000) }), 256), uses: { type: "integer", minimum: 0 } }), 256),
  unowned: { type: "integer", minimum: 0 },
});

const RESULT = object({
    schemaVersion: { const: TOOL_RESULT_SCHEMA_VERSION },
    tool: { type: "string", enum: [...RUNNER_TOOLS] },
    base: SHA,
    checkpoint: SHA,
    result: { type: "string", enum: ["found", "changed", "unchanged", "refused", "error"] },
    summary: text(TOOL_RESULT_LIMITS.summaryLength),
    impact: nullable(IMPACT_REPORT_SCHEMA),
    checks: list(BLOCK_CHECK_SCHEMA, BLOCK_CHECK_LIMITS.checks),
    decisions: list(LADDER_DECISION_SCHEMA, BLOCK_CHECK_LIMITS.checks),
    fix: nullable(TOOL_RUN),
    fixRef: nullable({ type: "string", pattern: "^refs/penguin/fixes/[0-9a-f]{40}(?:[0-9a-f]{24})?$" }),
    pushed: { const: false },
    durationMs: MS,
});

/** JSON Schema (draft 2020-12) of one agent tool result as the runner reports it. */
export const TOOL_RESULT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin agent tool result",
  ...RESULT,
  // `migration` and `rewrites` are optional: only an impact request that searched for retiring
  // symbols carries the first, and only Penguin's rewrite request the second.
  properties: { ...(RESULT["properties"] as Record<string, JsonSchema>), migration: MIGRATION, rewrites: MIGRATION_REWRITES_SCHEMA },
};

export type ParsedToolResult = { readonly ok: true; readonly result: AgentToolResult } | { readonly ok: false; readonly problems: string[] };

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? "").length;

/**
 * Checks a reported tool result's size, shape and fields: only `impact` carries an impact report,
 * only `check` carries checks and decisions, only `apply_fix` carries a fix, and a fix's commits
 * must start from the checkpoint. The ProjectAgent checks it belongs to the request.
 */
export function parseToolResult(value: unknown): ParsedToolResult {
  if (byteLength(value) > TOOL_RESULT_LIMITS.resultBytes) {
    return { ok: false, problems: [`the result is over ${TOOL_RESULT_LIMITS.resultBytes} bytes of JSON`] };
  }
  const errors = checkSchema(TOOL_RESULT_SCHEMA, value);
  if (errors.length > 0) return { ok: false, problems: errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`) };
  const result = value as AgentToolResult;
  const problems: string[] = [];
  if (result.tool !== "impact" && result.impact !== null) problems.push(`/impact a ${result.tool} result carries no impact report`);
  if (result.tool !== "check" && result.checks.length > 0) problems.push(`/checks a ${result.tool} result carries no checks`);
  // Only an impact result carries the retiring-calls steps; a check result carries the block checks' steps.
  const retiringSteps = result.decisions.filter((decision) => decision.check === "retiring").length;
  if (result.tool === "apply_fix" && result.decisions.length > 0) problems.push("/decisions an apply_fix result carries no next steps");
  if (result.tool === "impact" && retiringSteps !== result.decisions.length) problems.push("/decisions an impact result carries only retiring-calls steps");
  if (result.tool === "check" && retiringSteps > 0) problems.push("/decisions a check result carries no retiring-calls steps");
  if (result.tool !== "impact" && result.migration !== undefined) problems.push(`/migration a ${result.tool} result carries no migration groups`);
  if (result.tool !== "impact" && result.rewrites !== undefined) problems.push(`/rewrites a ${result.tool} result carries no rewrites`);
  if (result.tool !== "apply_fix" && (result.fix !== null || result.fixRef !== null)) problems.push(`/fix a ${result.tool} result carries no fix`);
  if (result.impact !== null && (result.impact.base !== result.base || result.impact.head !== result.checkpoint)) {
    problems.push("/impact names other commits than the result");
  }
  if (result.checks.some((check) => check.input.origin !== result.checkpoint)) problems.push("/checks start from another commit than the checkpoint");
  if (result.fix?.changed != null && result.fix.changed.before !== result.checkpoint) problems.push("/fix starts from another commit than the checkpoint");
  if (result.fixRef !== null && result.fixRef !== `refs/penguin/fixes/${result.fix?.changed?.after ?? ""}`) {
    problems.push("/fixRef does not name the fix's commit");
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, result };
}

/**
 * The result as the runner reports it. One over TOOL_RESULT_LIMITS.resultBytes drops the impact
 * report and says so in the summary, so it fits one stored row; the checks are bounded already.
 */
export function boundToolResult(result: AgentToolResult): AgentToolResult {
  if (byteLength(result) <= TOOL_RESULT_LIMITS.resultBytes || result.impact === null) return result;
  const summary = `${result.summary}; the impact report is over ${TOOL_RESULT_LIMITS.resultBytes} bytes and stays on the runner`;
  return { ...result, impact: null, summary: summary.slice(0, TOOL_RESULT_LIMITS.summaryLength) };
}
