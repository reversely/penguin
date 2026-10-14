// The caller replay on the check runner (packages/protocol, caller-replay.ts). When a change modifies
// a function a running feature's code calls, the combined run runs that feature's tests on the change
// merged onto its fork head, as it always does, with the bridge's pytest plugin
// (`analysis/replay/penguin_caller_replay.py`) loaded, and runs them once more on the fork head
// alone with the same plugin. The plugin wraps each changed function and records every call: the test,
// the frames that led to it, the arguments, the result or exception, and the effects. This module
// pairs the two recordings and gives each caller its verdict.
//
// A caller is the innermost frame of a call that sits in one of the feature's scopes, outside test
// code and outside the files the change itself changed: for a call made through a helper of the
// change, the feature's line that called the helper. Calls are paired by test, function, caller and
// order within the test, so a call keeps its id across runs of the same trees.
//
// Every recorded value is data the plugin wrote as JSON. It is parsed, compared as canonical JSON
// text and copied into the report with its size capped; nothing here evaluates it.

import { createHash } from "node:crypto";

import {
  CALLER_REPLAY_COMMAND_ID,
  CALLER_REPLAY_LIMITS,
  CALLER_REPLAY_SCHEMA_VERSION,
  CALLER_REPLAY_TOOL,
  REPLAY_EFFECT_KINDS,
  type CallerReplayRun,
  type CallerReplaySection,
  type CallerVerdict,
  type HeldReplay,
  type ImpactReport,
  type ImpactUse,
  type ReplayCall,
  type ReplayEffect,
  type ReplayEffectKind,
  type ReplaySide,
  type ReplayTestTally,
  type ReplayValue,
} from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

/** A changed function the plugin wraps, with the contract its callers are reported under. */
export interface ReplaySymbol {
  /** The dotted name the impact graph gives, such as `shared.platform.http.Client.post`. */
  readonly symbol: string;
  readonly module: string;
  /** The name inside the module, such as `Client.post`. */
  readonly qualname: string;
  /** The declared contract, or `path::qualname` when none covers the function. */
  readonly contract: string;
}

// Kinds of change that leave a caller reaching different code or none (python_impact.py, CALLER_CHANGES).
const CALLER_CHANGES: ReadonlySet<string> = new Set(["modified", "removed", "renamed", "moved"]);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method"]);
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

/** The module a repository path imports as: `a/b.py` is `a.b`, `a/__init__.py` is `a`. */
export function moduleOfPath(path: string): string | undefined {
  if (!path.endsWith(".py")) return undefined;
  const name = path.slice(0, -3).replaceAll("/", ".").replace(/\.__init__$/u, "");
  return DOTTED.test(name) ? name : undefined;
}

/** The changed functions and methods of an impact report that a caller can reach, at most the plugin's limit. */
export function replaySymbols(impact: ImpactReport): ReplaySymbol[] {
  const found = new Map<string, ReplaySymbol>();
  for (const change of impact.changes) {
    if (!CALLABLE_KINDS.has(change.kind) || !CALLER_CHANGES.has(change.change)) continue;
    const module = moduleOfPath(change.path);
    if (module === undefined || !change.symbol.startsWith(`${module}.`)) continue;
    const qualname = change.symbol.slice(module.length + 1);
    if (!DOTTED.test(qualname) || found.has(change.symbol)) continue;
    found.set(change.symbol, { symbol: change.symbol, module, qualname, contract: change.contract ?? `${change.path}::${qualname}` });
  }
  return [...found.values()].slice(0, CALLER_REPLAY_LIMITS.symbols);
}

/**
 * The changed functions plus the held ones (#193), each once, at most the plugin's limit. A held
 * function's module comes from its contract's path; one whose name lies outside that module is left out.
 */
export function withHeld(changed: readonly ReplaySymbol[], held: readonly HeldReplay[]): ReplaySymbol[] {
  const found = new Map(changed.map((entry) => [entry.symbol, entry]));
  for (const { symbol, contract } of held) {
    if (found.has(symbol)) continue;
    const module = moduleOfPath(contract.split("::")[0] ?? "");
    if (module === undefined || !symbol.startsWith(`${module}.`)) continue;
    const qualname = symbol.slice(module.length + 1);
    if (!DOTTED.test(qualname)) continue;
    found.set(symbol, { symbol, module, qualname, contract });
  }
  return [...found.values()].slice(0, CALLER_REPLAY_LIMITS.symbols);
}

/** Whether a path is test code: in a `tests` or `test` folder, or a `test_*.py`, `*_test.py` or `conftest.py` file. */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.slice(0, -1).some((part) => part === "tests" || part === "test") || /^test_.*\.py$|_test\.py$|^conftest\.py$/u.test(name);
}

// What the plugin writes.

export type TestOutcome = "passed" | "skipped" | "failed" | "error";

export interface CapturedCall {
  readonly symbol: string;
  readonly test: string;
  readonly frames: readonly { readonly path: string; readonly line: number }[];
  readonly args: ReplayValue;
  readonly approximate: boolean;
  readonly effects: readonly { readonly kind: ReplayEffectKind; readonly detail: ReplayValue }[];
  readonly effectCount: number;
  readonly outcome: { readonly status: "returned"; readonly value: ReplayValue } | { readonly status: "raised"; readonly error: { readonly type: string; readonly message: string } };
}

export interface Capture {
  readonly symbols: readonly { readonly symbol: string; readonly status: string; readonly reason: string | null }[];
  readonly calls: readonly CapturedCall[];
  readonly tests: ReadonlyMap<string, TestOutcome>;
  /** Calls past the plugin's limit and malformed entries left out. */
  readonly dropped: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const OUTCOMES: ReadonlySet<string> = new Set(["passed", "skipped", "failed", "error"]);
const EFFECT_KINDS: ReadonlySet<string> = new Set(REPLAY_EFFECT_KINDS);

/**
 * Reads what the plugin wrote: a Capture, or why there is none. Malformed entries are left out and
 * counted; the values inside each call stay JSON data.
 */
export function parseCapture(text: string | null | undefined): Capture | string {
  if (text === null || text === undefined) return "the test command wrote no recording; is it a pytest run?";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "the recording is not JSON";
  }
  if (!isRecord(raw) || raw["tool"] !== CALLER_REPLAY_TOOL || !Array.isArray(raw["calls"]) || !isRecord(raw["tests"])) return "the recording is not the plugin's";
  let dropped = typeof raw["dropped"] === "number" ? raw["dropped"] : 0;
  const calls: CapturedCall[] = [];
  for (const call of raw["calls"] as unknown[]) {
    const parsed = capturedCall(call);
    if (parsed === undefined) dropped += 1;
    else calls.push(parsed);
  }
  const tests = new Map<string, TestOutcome>();
  for (const [node, outcome] of Object.entries(raw["tests"] as Record<string, unknown>)) {
    if (typeof outcome === "string" && OUTCOMES.has(outcome)) tests.set(node, outcome as TestOutcome);
  }
  const symbols = (Array.isArray(raw["symbols"]) ? raw["symbols"] : []).filter(isRecord).map((entry) => ({
    symbol: String(entry["symbol"]).slice(0, 512),
    status: String(entry["status"]),
    reason: typeof entry["reason"] === "string" ? entry["reason"].slice(0, CALLER_REPLAY_LIMITS.textLength) : null,
  }));
  return { symbols, calls, tests, dropped };
}

/** One target's recordings of several scopes as one; the scopes that recorded nothing are left out. */
export function mergeCaptures(captures: readonly (Capture | string)[]): Capture | string {
  const recorded = captures.filter((capture): capture is Capture => typeof capture !== "string");
  if (recorded.length === 0) return captures.find((capture) => typeof capture === "string") ?? "no test command ran";
  if (recorded.length === 1) return recorded[0] as Capture;
  const symbols = new Map<string, Capture["symbols"][number]>();
  for (const capture of recorded) for (const entry of capture.symbols) if (symbols.get(entry.symbol)?.status !== "wrapped") symbols.set(entry.symbol, entry);
  return {
    symbols: [...symbols.values()],
    calls: recorded.flatMap((capture) => capture.calls),
    tests: new Map(recorded.flatMap((capture) => [...capture.tests])),
    dropped: recorded.reduce((sum, capture) => sum + capture.dropped, 0),
  };
}

function capturedCall(raw: unknown): CapturedCall | undefined {
  if (!isRecord(raw) || typeof raw["symbol"] !== "string" || typeof raw["test"] !== "string" || !Array.isArray(raw["frames"])) return undefined;
  const outcome = raw["outcome"];
  if (!isRecord(outcome)) return undefined;
  let parsedOutcome: CapturedCall["outcome"];
  if (outcome["status"] === "returned") parsedOutcome = { status: "returned", value: (outcome["value"] ?? null) as ReplayValue };
  else if (outcome["status"] === "raised" && isRecord(outcome["error"])) {
    parsedOutcome = { status: "raised", error: { type: String(outcome["error"]["type"]).slice(0, 256), message: String(outcome["error"]["message"]).slice(0, CALLER_REPLAY_LIMITS.textLength) } };
  } else return undefined;
  const frames = (raw["frames"] as unknown[]).flatMap((frame) =>
    isRecord(frame) && typeof frame["path"] === "string" && Number.isInteger(frame["line"]) ? [{ path: frame["path"], line: frame["line"] as number }] : [],
  );
  const effects = (Array.isArray(raw["effects"]) ? raw["effects"] : []).flatMap((effect) =>
    isRecord(effect) && typeof effect["kind"] === "string" && EFFECT_KINDS.has(effect["kind"]) ? [{ kind: effect["kind"] as ReplayEffectKind, detail: (effect["detail"] ?? null) as ReplayValue }] : [],
  );
  return {
    symbol: raw["symbol"],
    test: raw["test"].slice(0, CALLER_REPLAY_LIMITS.textLength),
    frames,
    args: (raw["args"] ?? null) as ReplayValue,
    approximate: raw["approximate"] === true,
    effects,
    effectCount: typeof raw["effectCount"] === "number" ? raw["effectCount"] : effects.length,
    outcome: parsedOutcome,
  };
}

// Pairing and verdicts.

export interface ReplayTargetInput {
  /** The running feature: the target id. */
  readonly feature: string;
  readonly origin: string;
  readonly forkCommit: string;
  readonly mergedCommit: string;
  /** The dependent scopes whose tests ran for the feature. */
  readonly scopes: readonly string[];
  readonly scopeMap: ScopeMap;
  readonly symbols: readonly ReplaySymbol[];
  /** Paths the change itself changed: a frame there is the change's own code, never a caller. */
  readonly changedPaths: ReadonlySet<string>;
  /** The feature's uses of the change from the impact graph; its calls are the callers no test may reach. */
  readonly uses: readonly ImpactUse[];
  /** The recording on the fork head and on the merged tree, or why each is missing. */
  readonly old: Capture | string;
  readonly new: Capture | string;
  readonly durationMs: number;
}

export interface ReplayTargetResult {
  readonly run: CallerReplayRun;
  readonly callers: readonly CallerVerdict[];
}

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

/** The id of the run that compared `forkCommit` and `mergedCommit` of one feature with `symbols` wrapped. */
export function replayRunId(origin: string, feature: string, forkCommit: string, mergedCommit: string, symbols: readonly string[]): string {
  return `replay-${sha([origin, feature, forkCommit, mergedCommit, [...symbols].sort()])}`;
}

/** The id of one call: its caller, test, function and place in the test's order. */
export function replayCallId(feature: string, contract: string, path: string, line: number, test: string, symbol: string, ordinal: number): string {
  return `call-${sha([feature, contract, path, line, test, symbol, ordinal])}`;
}

interface Placed {
  readonly call: CapturedCall;
  readonly contract: string;
  readonly path: string;
  readonly line: number;
  readonly ordinal: number;
}

/** Each call with its caller in the feature's code and its place in order; calls with no such caller are left out. */
function placeCalls(capture: Capture, isCaller: (path: string) => boolean, contracts: ReadonlyMap<string, string>): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const counts = new Map<string, number>();
  for (const call of capture.calls) {
    const contract = contracts.get(call.symbol);
    const site = call.frames.find((frame) => isCaller(frame.path));
    if (contract === undefined || site === undefined) continue;
    const order = JSON.stringify([call.test, call.symbol, site.path, site.line]);
    const ordinal = counts.get(order) ?? 0;
    counts.set(order, ordinal + 1);
    placed.set(JSON.stringify([call.test, call.symbol, site.path, site.line, ordinal]), { call, contract, path: site.path, line: site.line, ordinal });
  }
  return placed;
}

const canonical = (value: unknown): string => JSON.stringify(value ?? null);

/** A value capped at CALLER_REPLAY_LIMITS.valueChars of JSON text, kept as its digest and a preview past it. */
export function capValue(value: ReplayValue): ReplayValue {
  const text = canonical(value);
  if (text.length <= CALLER_REPLAY_LIMITS.valueChars) return value;
  return { $truncated: true, sha256: createHash("sha256").update(text).digest("hex"), chars: text.length, preview: text.slice(0, 200) };
}

/** One line for an effect, from its recorded detail. */
export function effectSummary(kind: ReplayEffectKind, detail: ReplayValue): string {
  const field = (name: string): string => (isRecord(detail) && detail[name] !== undefined ? (typeof detail[name] === "string" ? (detail[name] as string) : canonical(detail[name])) : "");
  const line =
    kind === "request" || kind === "http"
      ? `${field("method")} ${kind === "http" ? `${field("host")}${field("url")}` : field("url")}`
      : kind === "socket"
        ? `${field("op")} ${field("address")}`
        : kind === "file"
          ? `${field("op")} ${field("path") || field("paths")}`
          : `wrote ${field("path")} (${field("bytes")} bytes)`;
  return line.trim().slice(0, CALLER_REPLAY_LIMITS.textLength);
}

function side(call: CapturedCall | undefined): ReplaySide {
  if (call === undefined) return { status: "missing", args: null, value: null, error: null, effects: [], effectCount: 0, approximate: false };
  const effects: ReplayEffect[] = call.effects
    .slice(0, CALLER_REPLAY_LIMITS.effectsPerSide)
    .map((effect) => ({ kind: effect.kind, summary: effectSummary(effect.kind, effect.detail), detail: capValue(effect.detail) }));
  return {
    status: call.outcome.status,
    args: capValue(call.args),
    value: call.outcome.status === "returned" ? capValue(call.outcome.value) : null,
    error: call.outcome.status === "raised" ? call.outcome.error : null,
    effects,
    effectCount: call.effectCount,
    approximate: call.approximate,
  };
}

/** What differs between two sides of a call, from the full recordings. */
function differences(old: CapturedCall | undefined, now: CapturedCall | undefined): string[] {
  if (old === undefined) return ["extra"];
  if (now === undefined) return ["missing"];
  const found: string[] = [];
  const [a, b] = [old.outcome, now.outcome];
  if (a.status !== b.status) found.push("result", "exception");
  else if (a.status === "returned" && b.status === "returned" && canonical(a.value) !== canonical(b.value)) found.push("result");
  else if (a.status === "raised" && b.status === "raised" && canonical(a.error) !== canonical(b.error)) found.push("exception");
  if (old.effectCount !== now.effectCount || canonical(old.effects) !== canonical(now.effects)) found.push("effects");
  return found;
}

/** Why a pair breaks the caller, or undefined: a new or another exception, or a test that died before the call. */
function breaks(old: CapturedCall | undefined, now: CapturedCall | undefined, newTests: ReadonlyMap<string, TestOutcome>, test: string): string | undefined {
  if (old === undefined) return undefined;
  if (now === undefined) return newTests.get(test) === "error" ? `${test} dies on the merged tree before it makes the call` : undefined;
  if (now.outcome.status !== "raised") return undefined;
  if (old.outcome.status === "returned") return `${now.symbol} raises ${now.outcome.error.type} on the merged tree where it returned`;
  if (old.outcome.error.type !== now.outcome.error.type) return `${now.symbol} raises ${now.outcome.error.type} on the merged tree where it raised ${old.outcome.error.type}`;
  return undefined;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function tally(capture: Capture | string): ReplayTestTally {
  if (typeof capture === "string") return { passed: 0, failed: 0, errors: 0 };
  const outcomes = [...capture.tests.values()];
  return {
    passed: outcomes.filter((outcome) => outcome === "passed").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    errors: outcomes.filter((outcome) => outcome === "error").length,
  };
}

/** Pairs one feature's two recordings and gives each caller in the feature its verdict. */
export function replayTarget(input: ReplayTargetInput): ReplayTargetResult {
  const symbolNames = input.symbols.map((entry) => entry.symbol);
  const runId = replayRunId(input.origin, input.feature, input.forkCommit, input.mergedCommit, symbolNames);
  const contracts = new Map(input.symbols.map((entry) => [entry.symbol, entry.contract]));
  const scopes = new Set(input.scopes);
  const isCaller = (path: string): boolean => !isTestPath(path) && !input.changedPaths.has(path) && scopes.has(scopeForPath(input.scopeMap, path) ?? "");
  const unresolved = (["old", "new"] as const).flatMap((sideName) => {
    const capture = input[sideName];
    if (typeof capture === "string") return [];
    return capture.symbols.filter((entry) => entry.status !== "wrapped").map((entry) => ({ symbol: entry.symbol, side: sideName, reason: entry.reason ?? "not wrapped" }));
  });
  const error = [typeof input.old === "string" ? `fork head: ${input.old}` : "", typeof input.new === "string" ? `merged tree: ${input.new}` : ""].filter(Boolean).join("; ");
  const run: CallerReplayRun = {
    runId,
    feature: input.feature,
    origin: input.origin,
    forkCommit: input.forkCommit,
    mergedCommit: input.mergedCommit,
    scopes: [...input.scopes],
    symbols: symbolNames,
    unresolved: unresolved.slice(0, CALLER_REPLAY_LIMITS.symbols * 2),
    tests: { old: tally(input.old), new: tally(input.new) },
    recorded: { old: typeof input.old === "string" ? 0 : input.old.calls.length, new: typeof input.new === "string" ? 0 : input.new.calls.length },
    error: error === "" ? null : error.slice(0, CALLER_REPLAY_LIMITS.textLength),
    durationMs: Math.round(input.durationMs),
  };

  const callers: CallerVerdict[] = [];
  if (typeof input.old !== "string" && typeof input.new !== "string") {
    const oldTests = input.old.tests;
    const newTests = input.new.tests;
    const before = placeCalls(input.old, isCaller, contracts);
    const after = placeCalls(input.new, isCaller, contracts);
    const groups = new Map<string, { contract: string; path: string; line: number; keys: string[] }>();
    for (const [key, placed] of [...before, ...after]) {
      const group = JSON.stringify([placed.contract, placed.path, placed.line]);
      const entry = groups.get(group) ?? { contract: placed.contract, path: placed.path, line: placed.line, keys: [] };
      if (!entry.keys.includes(key)) entry.keys.push(key);
      groups.set(group, entry);
    }
    for (const { contract, path, line, keys } of groups.values()) {
      const differing: ReplayCall[] = [];
      const broken: string[] = [];
      const tests = new Set<string>();
      for (const key of keys) {
        const old = before.get(key);
        const now = after.get(key);
        const placed = (old ?? now) as Placed;
        tests.add(placed.call.test);
        const why = breaks(old?.call, now?.call, newTests, placed.call.test);
        if (why !== undefined) broken.push(why);
        const differs = differences(old?.call, now?.call);
        if (differs.length === 0) continue;
        differing.push({
          callId: replayCallId(input.feature, contract, path, line, placed.call.test, placed.call.symbol, placed.ordinal),
          test: placed.call.test,
          symbol: placed.call.symbol,
          ordinal: placed.ordinal,
          differs,
          old: side(old?.call),
          new: side(now?.call),
        });
      }
      // A test that reached the caller, passed on the fork head and fails on the merged tree.
      const failing = [...tests].filter((test) => oldTests.get(test) === "passed" && (newTests.get(test) === "failed" || newTests.get(test) === "error"));
      const kinds = [...new Set(differing.flatMap((call) => call.differs))];
      const [verdict, reason] =
        broken.length > 0
          ? (["broken", broken[0] as string] as const)
          : differing.length > 0
            ? (["differs", `${differing.length} of ${plural(keys.length, "call")} differ: ${kinds.join(", ")}`] as const)
            : failing.length > 0
              ? (["broken", `${failing[0]} fails on the merged tree although every call matches`] as const)
              : (["unaffected", `all ${plural(keys.length, "call")} match`] as const);
      callers.push({
        feature: input.feature,
        contract,
        path,
        line,
        verdict,
        reason: reason.slice(0, CALLER_REPLAY_LIMITS.textLength),
        runId,
        calls: keys.length,
        matched: keys.length - differing.length,
        differing: differing.slice(0, CALLER_REPLAY_LIMITS.differingPerCaller),
        differingCount: differing.length,
        tests: [...tests].sort().slice(0, 20),
      });
    }
  }

  // The impact graph's calls in the feature's code that no recorded call came through.
  const reached = new Set(callers.map((caller) => JSON.stringify([caller.contract, caller.path, caller.line])));
  const bySymbol = new Map(input.symbols.map((entry) => [entry.symbol, entry]));
  const scopeNames = [...input.scopes].join(", ");
  const unknownReason =
    run.error === null ? `no test of ${scopeNames} reaches this call; only pyright and the call-site signature check ran` : `the replay recorded no calls (${run.error}); only pyright and the call-site signature check ran`;
  for (const use of input.uses) {
    if (use.kind !== "call" || !isCaller(use.path)) continue;
    const symbol = bySymbol.get(use.symbol) ?? bySymbol.get(`${use.symbol}.__init__`);
    if (symbol === undefined) continue;
    const key = JSON.stringify([symbol.contract, use.path, use.line]);
    if (reached.has(key)) continue;
    reached.add(key);
    callers.push({
      feature: input.feature,
      contract: symbol.contract,
      path: use.path,
      line: use.line,
      verdict: "unknown_reach",
      reason: unknownReason.slice(0, CALLER_REPLAY_LIMITS.textLength),
      runId,
      calls: 0,
      matched: 0,
      differing: [],
      differingCount: 0,
      tests: [],
    });
  }
  callers.sort((a, b) => (a.path === b.path ? a.line - b.line || (a.contract < b.contract ? -1 : 1) : a.path < b.path ? -1 : 1));
  return { run, callers };
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The `caller_replay` section of a run's report, its runs and callers in target order and capped. A
 * section over CALLER_REPLAY_LIMITS.sectionBytes first drops the differing calls' arguments, then
 * keeps one differing call per caller, then none; `trimmed` says so and every count stays.
 */
export function callerReplaySection(results: readonly ReplayTargetResult[]): CallerReplaySection {
  const runs = results.map((result) => result.run).slice(0, CALLER_REPLAY_LIMITS.runs);
  const kept = new Set(runs.map((run) => run.runId));
  const callers = results.flatMap((result) => result.callers).filter((caller) => kept.has(caller.runId)).slice(0, CALLER_REPLAY_LIMITS.callers);
  const section: CallerReplaySection = {
    schemaVersion: CALLER_REPLAY_SCHEMA_VERSION,
    tool: CALLER_REPLAY_TOOL,
    commandId: CALLER_REPLAY_COMMAND_ID,
    runs,
    callers,
    trimmed: false,
  };
  if (bytes(section) <= CALLER_REPLAY_LIMITS.sectionBytes) return section;
  const steps: ((caller: CallerVerdict) => CallerVerdict)[] = [
    (caller) => ({ ...caller, differing: caller.differing.map((call) => ({ ...call, old: { ...call.old, args: null }, new: { ...call.new, args: null } })) }),
    (caller) => ({ ...caller, differing: caller.differing.slice(0, 1) }),
    (caller) => ({ ...caller, differing: [] }),
  ];
  let trimmed: CallerReplaySection = { ...section, trimmed: true };
  for (const step of steps) {
    trimmed = { ...trimmed, callers: trimmed.callers.map(step) };
    if (bytes(trimmed) <= CALLER_REPLAY_LIMITS.sectionBytes) return trimmed;
  }
  return trimmed;
}

/** The section as text for a terminal: one line per caller, then each differing call. */
export function formatCallerReplay(section: CallerReplaySection): string {
  const lines: string[] = [];
  for (const run of section.runs) {
    const tests = `${run.tests.old.passed}/${run.tests.new.passed} passed on the fork head/merged tree`;
    lines.push(`${run.feature} ${run.runId} (${run.scopes.join(", ")}): ${run.recorded.old} and ${run.recorded.new} calls recorded, ${tests}${run.error === null ? "" : `; ${run.error}`}`);
    for (const caller of section.callers.filter((each) => each.runId === run.runId)) {
      lines.push(`  ${caller.path}:${caller.line} ${caller.contract} ${caller.verdict}: ${caller.reason}`);
      for (const call of caller.differing) {
        const show = (recorded: ReplaySide) =>
          recorded.status === "raised" ? `raised ${recorded.error?.type}` : recorded.status === "missing" ? "missing" : `returned ${canonical(recorded.value).slice(0, 80)}`;
        lines.push(`    ${call.callId} ${call.test}: ${show(call.old)}, ${call.old.effectCount} effects -> ${show(call.new)}, ${call.new.effectCount} effects`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
