// The caller replay of a change (the `caller_replay` section of a check or block run): for each
// running feature whose code calls a function the change modifies, the check runner runs that
// feature's own tests twice with the changed functions wrapped, once on the feature's fork head and
// once on the change merged onto it, and pairs every recorded call. Each caller, one call site in
// the feature's code, gets a verdict:
//
// - `unaffected`: every call through it returned the same value, raised the same exception and had
//   the same effects on both trees.
// - `broken`: a call raises on the merged tree where it returned, or raises another exception; a
//   test that made a call died on the merged tree before making it again; or every call matches yet
//   a test that reached the caller fails on the merged tree only.
// - `differs`: a call's result, exception message or effects differ, or a call happens on one tree only.
// - `unknown_reach`: the impact graph shows the call, but no test of the feature reaches it, so only
//   pyright and the call-site signature check ran.
//
// A recorded value is data only: canonical JSON written by the bridge's pytest plugin, never
// evaluated. A value the plugin could not read field by field is its `repr`, and the call is marked
// approximate. Every value, list and text has a size cap.
//
// Ids are stable: a run id is fixed by the commits it compared and the functions it wrapped; a call
// id by the caller, the test, the function and the call's place in that test's order, so the same
// call keeps its id when the change is revised and the replay runs again. A later ticket's tools
// cite them as evidence, so `replayRun` and `replayCall` look them up.

import { checkSchema, type JsonSchema } from "./schema-check.ts";

export const CALLER_REPLAY_SCHEMA_VERSION = 1;
export const CALLER_REPLAY_TOOL = "caller-replay";
export const CALLER_REPLAY_COMMAND_ID = "analysis:caller-replay";

export const CALLER_VERDICTS = ["unaffected", "broken", "differs", "unknown_reach"] as const;
export type CallerVerdictKind = (typeof CALLER_VERDICTS)[number];

/** How a call ended on one tree; `missing` when that tree's tests never made the call. */
export const REPLAY_CALL_STATUSES = ["returned", "raised", "missing"] as const;
export type ReplayCallStatus = (typeof REPLAY_CALL_STATUSES)[number];

/**
 * `request`: a request object handed to a transport, such as a vendored HTTP client's. `http`: a
 * request through `http.client`, which `urllib` uses. `socket`: a connect or send. `file`: a file
 * opened for writing, moved or removed. `file-content`: a written file's size and digest when the call ended.
 */
export const REPLAY_EFFECT_KINDS = ["request", "http", "socket", "file", "file-content"] as const;
export type ReplayEffectKind = (typeof REPLAY_EFFECT_KINDS)[number];

export const CALLER_REPLAY_LIMITS = {
  runs: 128,
  callers: 256,
  differingPerCaller: 5,
  effectsPerSide: 8,
  /** The JSON text of one recorded value: arguments, a result or an effect's detail. */
  valueChars: 2_048,
  textLength: 500,
  symbols: 64,
  pathLength: 1_024,
  /** The JSON text of a whole section, so it fits a run's report beside its checks. */
  sectionBytes: 262_144,
} as const;

/** A run id: `replay-` and 20 hexadecimal digits of the SHA-256 of what the run compared. */
export const REPLAY_RUN_ID_PATTERN = "^replay-[0-9a-f]{20}$";
/** A call id: `call-` and 20 hexadecimal digits of the SHA-256 of the call's caller, test, function and order. */
export const REPLAY_CALL_ID_PATTERN = "^call-[0-9a-f]{20}$";

/** A recorded value: canonical JSON from the plugin, never code. */
export type ReplayValue = null | boolean | number | string | readonly ReplayValue[] | { readonly [key: string]: ReplayValue };

export interface ReplayEffect {
  readonly kind: ReplayEffectKind;
  /** One line, such as `POST https://processor.example.invalid/v1/payouts`. */
  readonly summary: string;
  readonly detail: ReplayValue;
}

/** One call on one tree. */
export interface ReplaySide {
  readonly status: ReplayCallStatus;
  /** The arguments by parameter name, `self` included; null when the call is missing. */
  readonly args: ReplayValue;
  /** The returned value; null unless `returned`. */
  readonly value: ReplayValue;
  readonly error: { readonly type: string; readonly message: string } | null;
  /** The first effects, in order. */
  readonly effects: readonly ReplayEffect[];
  /** Every effect, including those past the limit. */
  readonly effectCount: number;
  /** True when some value is a `repr`, not a field-by-field encoding. */
  readonly approximate: boolean;
}

/** A call whose two sides differ. */
export interface ReplayCall {
  readonly callId: string;
  /** The pytest node id of the test that made the call. */
  readonly test: string;
  /** The changed function, as the impact graph names it, such as `shared.platform.http.Client.post`. */
  readonly symbol: string;
  /** The call's place among the test's calls of `symbol` from this caller, from 0. */
  readonly ordinal: number;
  /** What differs: `result`, `exception`, `effects`, `missing` or `extra`. */
  readonly differs: readonly string[];
  readonly old: ReplaySide;
  readonly new: ReplaySide;
}

/** One caller of a changed contract in one running feature, and its verdict. */
export interface CallerVerdict {
  /** The running feature: the block's or check's target id. */
  readonly feature: string;
  /** The declared contract the changed function belongs to, or `path::name` when none is declared. */
  readonly contract: string;
  /** The call site in the feature's code. */
  readonly path: string;
  readonly line: number;
  readonly verdict: CallerVerdictKind;
  /** One line that says why. */
  readonly reason: string;
  /** The replay run that compared this caller's calls. */
  readonly runId: string;
  /** Calls through this caller, on either tree. */
  readonly calls: number;
  readonly matched: number;
  /** The first differing calls. */
  readonly differing: readonly ReplayCall[];
  /** Every differing call, including those past the limit. */
  readonly differingCount: number;
  /** The tests that reached the caller, by pytest node id; the first ones. */
  readonly tests: readonly string[];
}

export interface ReplayTestTally {
  readonly passed: number;
  readonly failed: number;
  /** Tests that died with an exception other than a failed assertion, or did not collect. */
  readonly errors: number;
}

/** One replay run: one running feature's tests on its fork head and on the change merged onto it. */
export interface CallerReplayRun {
  readonly runId: string;
  readonly feature: string;
  /** The originating checkpoint. */
  readonly origin: string;
  /** The feature's fork head: the old tree. */
  readonly forkCommit: string;
  /** The checkpoint merged onto the fork head: the new tree. */
  readonly mergedCommit: string;
  /** The scopes whose tests ran, as `test:<scope>` commands. */
  readonly scopes: readonly string[];
  /** The changed functions wrapped. */
  readonly symbols: readonly string[];
  /** Functions the plugin could not wrap on one tree, and why. */
  readonly unresolved: readonly { readonly symbol: string; readonly side: "old" | "new"; readonly reason: string }[];
  readonly tests: { readonly old: ReplayTestTally; readonly new: ReplayTestTally };
  /** Calls recorded on the old and the new tree, before pairing. */
  readonly recorded: { readonly old: number; readonly new: number };
  /** Why a side recorded nothing, such as a test command that is not pytest; null when both did. */
  readonly error: string | null;
  /** The replay's extra run of the feature's tests, on the fork head; the merged run is the tests check's own. */
  readonly durationMs: number;
}

export interface CallerReplaySection {
  readonly schemaVersion: typeof CALLER_REPLAY_SCHEMA_VERSION;
  readonly tool: typeof CALLER_REPLAY_TOOL;
  readonly commandId: typeof CALLER_REPLAY_COMMAND_ID;
  readonly runs: readonly CallerReplayRun[];
  readonly callers: readonly CallerVerdict[];
  /** True when differing calls were left out to keep the section under its byte limit. */
  readonly trimmed: boolean;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const text = (maxLength: number, minLength = 0): JsonSchema => ({ type: "string", minLength, maxLength });
const count = { type: "integer", minimum: 0 };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const list = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", maxItems, items });
const SYMBOL = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$", maxLength: 512 };
const FEATURE = { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$", maxLength: 64 };
const PATH = text(CALLER_REPLAY_LIMITS.pathLength, 1);
const TALLY = object({ passed: count, failed: count, errors: count });

const SIDE = object({
  status: { type: "string", enum: [...REPLAY_CALL_STATUSES] },
  // A recorded value is any JSON; parseCallerReplay checks its size.
  args: {},
  value: {},
  error: nullable(object({ type: text(256, 1), message: text(CALLER_REPLAY_LIMITS.textLength) })),
  effects: list(
    object({ kind: { type: "string", enum: [...REPLAY_EFFECT_KINDS] }, summary: text(CALLER_REPLAY_LIMITS.textLength), detail: {} }),
    CALLER_REPLAY_LIMITS.effectsPerSide,
  ),
  effectCount: count,
  approximate: { type: "boolean" },
});

const CALL = object({
  callId: { type: "string", pattern: REPLAY_CALL_ID_PATTERN },
  test: text(CALLER_REPLAY_LIMITS.textLength, 1),
  symbol: SYMBOL,
  ordinal: count,
  differs: list({ type: "string", enum: ["result", "exception", "effects", "missing", "extra"] }, 5),
  old: SIDE,
  new: SIDE,
});

/** JSON Schema (draft 2020-12) of the `caller_replay` section. */
export const CALLER_REPLAY_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin caller replay",
  ...object({
    schemaVersion: { const: CALLER_REPLAY_SCHEMA_VERSION },
    tool: { const: CALLER_REPLAY_TOOL },
    commandId: { const: CALLER_REPLAY_COMMAND_ID },
    runs: list(
      object({
        runId: { type: "string", pattern: REPLAY_RUN_ID_PATTERN },
        feature: FEATURE,
        origin: SHA,
        forkCommit: SHA,
        mergedCommit: SHA,
        scopes: list(text(128, 1), 64),
        symbols: list(SYMBOL, CALLER_REPLAY_LIMITS.symbols),
        unresolved: list(object({ symbol: text(512, 1), side: { type: "string", enum: ["old", "new"] }, reason: text(CALLER_REPLAY_LIMITS.textLength) }), CALLER_REPLAY_LIMITS.symbols * 2),
        tests: object({ old: TALLY, new: TALLY }),
        recorded: object({ old: count, new: count }),
        error: nullable(text(CALLER_REPLAY_LIMITS.textLength, 1)),
        durationMs: count,
      }),
      CALLER_REPLAY_LIMITS.runs,
    ),
    callers: list(
      object({
        feature: FEATURE,
        contract: text(CALLER_REPLAY_LIMITS.pathLength, 1),
        path: PATH,
        line: { type: "integer", minimum: 1 },
        verdict: { type: "string", enum: [...CALLER_VERDICTS] },
        reason: text(CALLER_REPLAY_LIMITS.textLength, 1),
        runId: { type: "string", pattern: REPLAY_RUN_ID_PATTERN },
        calls: count,
        matched: count,
        differing: list(CALL, CALLER_REPLAY_LIMITS.differingPerCaller),
        differingCount: count,
        tests: list(text(CALLER_REPLAY_LIMITS.textLength, 1), 20),
      }),
      CALLER_REPLAY_LIMITS.callers,
    ),
    trimmed: { type: "boolean" },
  }),
};

export type ParsedCallerReplay = { readonly ok: true; readonly section: CallerReplaySection } | { readonly ok: false; readonly problems: string[] };

const jsonChars = (value: unknown): number => JSON.stringify(value ?? null).length;
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? "").length;

/**
 * Checks a `caller_replay` section from the network: its shape, the size of every recorded value
 * and of the whole section, that each caller names a run of the section for its own feature, that
 * call ids are unique within a run, and that each verdict agrees with its calls: `unaffected` and
 * `unknown_reach` carry no differing call, `differs` carries at least one.
 */
export function parseCallerReplay(value: unknown): ParsedCallerReplay {
  if (byteLength(value) > CALLER_REPLAY_LIMITS.sectionBytes) {
    return { ok: false, problems: [`the section is over ${CALLER_REPLAY_LIMITS.sectionBytes} bytes of JSON`] };
  }
  const errors = checkSchema(CALLER_REPLAY_SCHEMA, value);
  if (errors.length > 0) return { ok: false, problems: errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`) };
  const section = value as CallerReplaySection;
  const problems: string[] = [];
  const runs = new Map(section.runs.map((run) => [run.runId, run]));
  if (runs.size !== section.runs.length) problems.push("/runs names a run id twice");
  const callIds = new Map<string, Set<string>>();
  section.callers.forEach((caller, index) => {
    const at = `/callers/${index}`;
    const run = runs.get(caller.runId);
    if (run === undefined) problems.push(`${at} names run ${caller.runId}, which the section does not hold`);
    else if (run.feature !== caller.feature) problems.push(`${at} is a caller in ${caller.feature}, but its run replayed ${run.feature}`);
    if (caller.differing.length > caller.differingCount) problems.push(`${at}/differingCount is less than the calls listed`);
    if ((caller.verdict === "unaffected" || caller.verdict === "unknown_reach") && caller.differingCount > 0) {
      problems.push(`${at} is ${caller.verdict} but lists differing calls`);
    }
    if (caller.verdict === "differs" && caller.differingCount === 0) problems.push(`${at} differs but lists no differing call`);
    const seen = callIds.get(caller.runId) ?? new Set<string>();
    callIds.set(caller.runId, seen);
    caller.differing.forEach((call, callIndex) => {
      if (seen.has(call.callId)) problems.push(`${at}/differing/${callIndex} repeats call ${call.callId}`);
      seen.add(call.callId);
      for (const [side, recorded] of [["old", call.old], ["new", call.new]] as const) {
        for (const [field, item] of [["args", recorded.args], ["value", recorded.value], ...recorded.effects.map((effect, n) => [`effects/${n}/detail`, effect.detail] as const)] as const) {
          if (jsonChars(item) > CALLER_REPLAY_LIMITS.valueChars) problems.push(`${at}/differing/${callIndex}/${side}/${field} is over ${CALLER_REPLAY_LIMITS.valueChars} characters of JSON`);
        }
      }
    });
  });
  return problems.length > 0 ? { ok: false, problems: problems.slice(0, 10) } : { ok: true, section };
}

/**
 * Problems with a run report's `callerReplay`, each under `/callerReplay`: the section's own checks,
 * then every replay run starting from the report's checkpoint and, when `forks` is given (feature id
 * to the fork head the run named), replaying only those forks at those heads.
 */
export function callerReplayProblems(value: unknown, origin: string, forks?: ReadonlyMap<string, string>): string[] {
  const parsed = parseCallerReplay(value);
  if (!parsed.ok) return parsed.problems.map((problem) => `/callerReplay${problem.startsWith("/") ? "" : " "}${problem}`);
  const problems: string[] = [];
  parsed.section.runs.forEach((run, index) => {
    if (run.origin !== origin) problems.push(`/callerReplay/runs/${index} starts from another commit than the checkpoint`);
    if (forks === undefined) return;
    const head = forks.get(run.feature);
    if (head === undefined) problems.push(`/callerReplay/runs/${index} replays ${run.feature}, which the run does not name`);
    else if (head !== run.forkCommit) problems.push(`/callerReplay/runs/${index} replays ${run.feature} at another commit than the run named`);
  });
  return problems;
}

/** The replay run with id `runId`, or undefined. */
export function replayRun(section: CallerReplaySection, runId: string): CallerReplayRun | undefined {
  return section.runs.find((run) => run.runId === runId);
}

/** The differing call `callId` of run `runId` with the caller that made it, or undefined. */
export function replayCall(section: CallerReplaySection, runId: string, callId: string): { readonly caller: CallerVerdict; readonly call: ReplayCall } | undefined {
  for (const caller of section.callers) {
    if (caller.runId !== runId) continue;
    const call = caller.differing.find((each) => each.callId === callId);
    if (call !== undefined) return { caller, call };
  }
  return undefined;
}

/** The callers in one running feature, in section order. */
export function callersIn(section: CallerReplaySection, feature: string): CallerVerdict[] {
  return section.callers.filter((caller) => caller.feature === feature);
}

/** The callers of one feature and contract, as one later per-caller item gathers them. */
export function callersOfContract(section: CallerReplaySection, feature: string, contract: string): CallerVerdict[] {
  return section.callers.filter((caller) => caller.feature === feature && caller.contract === contract);
}
