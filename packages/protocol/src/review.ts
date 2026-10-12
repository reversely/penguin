// The review harness (PRD 0.4 section 6): the fixed review form an affected scope's agent fills in
// for a plan part, its deterministic validation, the stored data rule, and the record of a
// side-by-side run of the scope's public functions on main and on the fork.
//
// A form holds one row per invariant of the reviewing scope: a verdict of holds, breaks or unknown,
// the evidence (a test or a code location in the fork) and the effect on data stored before the
// change. It may name risky inputs to run on old and new code, and the marker (a migration, a
// backfill or a cutover) that the stored data rule asks for. Every string is length-limited and kept
// as data: Penguin never runs or interprets form text, and evidence is only looked up in the fork.

import { checkSchema, type JsonSchema } from "./schema-check.ts";

export const SIDE_BY_SIDE_COMMAND_ID = "analysis:side-by-side";
export const SIDE_BY_SIDE_TOOL = "side-by-side";
export const REVIEW_SCHEMA_VERSION = 1;

export const REVIEW_LIMITS = {
  rows: 200,
  evidencePerRow: 10,
  evidenceLength: 600,
  storedDataLength: 2_000,
  riskyInputs: 50,
  nameLength: 200,
  /** The JSON text of one risky input's arguments. */
  argsBytes: 65_536,
  argsDepth: 16,
  examplesPerFile: 5_000,
  /** The differing and the not-run inputs each set keeps in a record over `recordBytes`. */
  recordedPerSet: 100,
  /** The JSON text of one review record the runner reports. A Durable Object row holds 2 MB. */
  recordBytes: 1_048_576,
} as const;

export const REVIEW_VERDICTS = ["holds", "breaks", "unknown"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const STORED_DATA_MARKERS = ["migration", "backfill", "cutover"] as const;
export type StoredDataMarkerKind = (typeof STORED_DATA_MARKERS)[number];

export interface ReviewRow {
  /** The invariant's id from `penguin/invariants.json`. */
  readonly invariant: string;
  readonly verdict: ReviewVerdict;
  /** Tests (`path::name`) or code locations (`path:line`, `path::Symbol`) in the fork. */
  readonly evidence: readonly string[];
  /** The effect on data stored before the change, in the reviewer's words. */
  readonly storedData: string;
}

/** An input the reviewer expects to behave differently, run on old and new code as data. */
export interface RiskyInput {
  readonly name: string;
  /** A public function of the reviewing scope: a contract `path::symbol` from `penguin/scopes.json`. */
  readonly contract: string;
  /** The invariant the input bears on, if any. */
  readonly invariant?: string;
  /** Keyword arguments as JSON, built into the function's parameter types (see side_by_side.py). */
  readonly args: Readonly<Record<string, unknown>>;
}

export interface StoredDataMarker {
  readonly kind: StoredDataMarkerKind;
  /** Where the marker is in the fork: a test or a code location. */
  readonly evidence: string;
}

export interface ReviewForm {
  readonly rows: readonly ReviewRow[];
  readonly riskyInputs: readonly RiskyInput[];
  readonly storedDataMarker: StoredDataMarker | null;
}

/** An invariant as the form is checked against it; `Invariant` in `@penguin/scope-map`. */
export interface InvariantView {
  readonly id: string;
  readonly scopeId: string;
  readonly statement: string;
  readonly protected: boolean;
}

export const REVIEW_REFUSAL_CODES = [
  "invalid_form",
  "missing_row",
  "unknown_invariant",
  "duplicate_row",
  "no_evidence",
  "invalid_evidence",
  "evidence_not_found",
  "unknown_without_test",
  "stored_data_without_marker",
] as const;
export type ReviewRefusalCode = (typeof REVIEW_REFUSAL_CODES)[number];

/** One reason a form is refused. `invariant` and `evidence` are the reviewer's data, echoed back. */
export interface ReviewRefusal {
  readonly code: ReviewRefusalCode;
  readonly message: string;
  readonly invariant?: string;
  readonly evidence?: string;
}

const NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$";
const text = (maxLength: number, minLength = 0): JsonSchema => ({ type: "string", minLength, maxLength });

/** JSON Schema (draft 2020-12) of the form as submitted. */
export const REVIEW_FORM_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin review form",
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      maxItems: REVIEW_LIMITS.rows,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["invariant", "verdict", "evidence", "storedData"],
        properties: {
          invariant: text(64, 1),
          verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
          evidence: { type: "array", maxItems: REVIEW_LIMITS.evidencePerRow, items: text(REVIEW_LIMITS.evidenceLength, 1) },
          storedData: text(REVIEW_LIMITS.storedDataLength),
        },
      },
    },
    riskyInputs: {
      type: "array",
      maxItems: REVIEW_LIMITS.riskyInputs,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "contract", "args"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: REVIEW_LIMITS.nameLength, pattern: NAME_PATTERN },
          contract: text(512, 1),
          invariant: text(64, 1),
          args: { type: "object" },
        },
      },
    },
    storedDataMarker: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "evidence"],
          properties: {
            kind: { type: "string", enum: [...STORED_DATA_MARKERS] },
            evidence: text(REVIEW_LIMITS.evidenceLength, 1),
          },
        },
      ],
    },
  },
};

/** The depth of nested arrays and objects in a JSON value; 0 for a scalar. */
function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  if (typeof value === "object" && value !== null) return 1 + Math.max(0, ...Object.values(value).map(jsonDepth));
  return 0;
}

export type ParsedReviewForm = { readonly ok: true; readonly form: ReviewForm } | { readonly ok: false; readonly refusals: ReviewRefusal[] };

/** Checks a submitted form's shape and limits. Content rules are `validateReviewForm`'s. */
export function parseReviewForm(value: unknown): ParsedReviewForm {
  const errors = checkSchema(REVIEW_FORM_SCHEMA, value);
  const refusals: ReviewRefusal[] = errors
    .slice(0, 20)
    .map((error) => ({ code: "invalid_form", message: `${error.path || "/"} ${error.message}` }));
  if (refusals.length > 0) return { ok: false, refusals };
  const raw = value as { rows: ReviewRow[]; riskyInputs?: RiskyInput[]; storedDataMarker?: StoredDataMarker | null };
  (raw.riskyInputs ?? []).forEach((input, index) => {
    if (new TextEncoder().encode(JSON.stringify(input.args)).length > REVIEW_LIMITS.argsBytes) {
      refusals.push({ code: "invalid_form", message: `/riskyInputs/${index}/args is over ${REVIEW_LIMITS.argsBytes} bytes of JSON` });
    } else if (jsonDepth(input.args) > REVIEW_LIMITS.argsDepth) {
      refusals.push({ code: "invalid_form", message: `/riskyInputs/${index}/args nests deeper than ${REVIEW_LIMITS.argsDepth} levels` });
    }
  });
  const names = (raw.riskyInputs ?? []).map((input) => input.name);
  if (new Set(names).size !== names.length) refusals.push({ code: "invalid_form", message: "/riskyInputs names must be unique" });
  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    form: { rows: raw.rows, riskyInputs: raw.riskyInputs ?? [], storedDataMarker: raw.storedDataMarker ?? null },
  };
}

/** A piece of evidence: a definition (`path::Name::name`) or a line (`path:line`) in the fork. */
export type Evidence =
  | { readonly kind: "symbol"; readonly path: string; readonly names: readonly string[]; readonly test: boolean }
  | { readonly kind: "line"; readonly path: string; readonly line: number };

/** One path segment: letters, digits, '_', '.' and '-', not '.' or '..' and not starting with '-'. */
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const TEST_FILE = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/u;

/** A relative path that stays inside the repository, or undefined. */
export function parseRepoPath(path: string): string | undefined {
  if (path.length === 0 || path.length > 512) return undefined;
  const segments = path.split("/");
  return segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..") ? path : undefined;
}

/**
 * Parses one evidence string. `path::name` and `path::Class::name` name a definition, written as a
 * pytest node ID; it is a test when the file is a test file (`test_*.py`, `*_test.py`) and the last
 * name starts with `test`. `path:line` names a line. Anything else is undefined.
 */
export function parseEvidence(value: string): Evidence | undefined {
  const symbolAt = value.indexOf("::");
  if (symbolAt > 0) {
    const path = parseRepoPath(value.slice(0, symbolAt));
    const names = value.slice(symbolAt + 2).split("::");
    if (path === undefined || names.length > 4 || !names.every((name) => IDENTIFIER.test(name))) return undefined;
    const last = names[names.length - 1] as string;
    return { kind: "symbol", path, names, test: TEST_FILE.test(path) && last.startsWith("test") };
  }
  const line = /^(.+):([1-9][0-9]{0,6})$/u.exec(value);
  const path = line === null ? undefined : parseRepoPath(line[1] as string);
  return path === undefined ? undefined : { kind: "line", path, line: Number(line?.[2]) };
}

const escapeRegExp = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const indentOf = (line: string) => (/^[ \t]*/u.exec(line) as RegExpExecArray)[0].length;
const isBlank = (line: string) => /^\s*(?:#.*)?$/u.test(line);

/**
 * Whether `names` is defined in Python source `text`: the first name at the top level, each later
 * one inside the block of the one before. A plain text scan, so the fork's code is never run.
 */
function definesSymbol(text: string, names: readonly string[]): boolean {
  const lines = text.split(/\r?\n/u);
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;
  for (const [index, name] of names.entries()) {
    const keyword = index < names.length - 1 ? "class" : "(?:async\\s+def|def|class)";
    const pattern = new RegExp(`^([ \\t]*)${keyword}\\s+${escapeRegExp(name)}\\b`, "u");
    let found = -1;
    for (let at = start; at < end && found < 0; at += 1) {
      const match = pattern.exec(lines[at] as string);
      const indent = match === null ? -1 : (match[1] as string).length;
      if (match !== null && (parentIndent < 0 ? indent === 0 : indent > parentIndent)) found = at;
    }
    if (found < 0) return false;
    parentIndent = indentOf(lines[found] as string);
    start = found + 1;
    let blockEnd = start;
    while (blockEnd < end && (isBlank(lines[blockEnd] as string) || indentOf(lines[blockEnd] as string) > parentIndent)) blockEnd += 1;
    end = blockEnd;
  }
  return true;
}

/**
 * Why the evidence does not exist in the fork, or null when it does. `file` is the text of the
 * evidence's file at the fork's commit, or null when the fork has no such file.
 */
export function evidenceProblem(evidence: Evidence, file: string | null): string | null {
  if (file === null) return `${evidence.path} does not exist in the fork`;
  if (evidence.kind === "line") {
    const lines = file.split(/\r?\n/u).length - (file.endsWith("\n") ? 1 : 0);
    return evidence.line <= lines ? null : `${evidence.path} has ${lines} lines, not ${evidence.line}`;
  }
  return definesSymbol(file, evidence.names) ? null : `${evidence.path} defines no ${evidence.names.join(".")}`;
}

/** Every file the form's evidence and marker name, so the caller reads each once from the fork. */
export function evidencePaths(form: ReviewForm): string[] {
  const texts = [...form.rows.flatMap((row) => row.evidence), ...(form.storedDataMarker ? [form.storedDataMarker.evidence] : [])];
  const paths = texts.map((value) => parseEvidence(value)?.path).filter((path): path is string => path !== undefined);
  return [...new Set(paths)].sort();
}

/** A stored data shape the contract diff reports (`ImpactDataShape`), as the rule reads it. */
export interface StoredShapeChange {
  readonly symbol: string;
  readonly path: string;
  /**
   * The scope whose files define the shape, which owns the store; null when no scope holds the path.
   * Absent on a record from before #132, which the rule reads as the reviewing scope's own shape.
   */
  readonly scope?: string | null;
}

/**
 * Whether the reviewing scope `scope` owns `shape`: its own files define it, so the scope persists
 * that data itself, such as a dashboard's stored metrics. A shape of another scope it only reads.
 */
export function ownsShape(shape: StoredShapeChange, scope: string): boolean {
  return shape.scope === undefined || shape.scope === scope;
}

/**
 * The changed stored shapes a review's scope only reads: another scope owns each one. The migration or
 * backfill for them belongs in the change that owns the store, not in the reader's part (#132).
 */
export function readOnlyShapes(record: Pick<ReviewRecord, "scope" | "storedShapes">): StoredShapeChange[] {
  return (record.storedShapes ?? []).filter((shape) => !ownsShape(shape, record.scope));
}

export interface ReviewValidationInput {
  readonly form: ReviewForm;
  /** The reviewing scope, whose own changed stored shapes need the form's marker. */
  readonly scope: string;
  /** The reviewing scope's invariants from `penguin/invariants.json` on main. */
  readonly invariants: readonly InvariantView[];
  /** Each path from `evidencePaths(form)` with its text in the fork, or null when it is missing. */
  readonly files: ReadonlyMap<string, string | null>;
  /**
   * The stored data shapes the contract diff shows changed, or null while the diff is not known.
   * With null, the stored data rule is left to the check runner, which has the diff.
   */
  readonly storedShapes: readonly StoredShapeChange[] | null;
}

export interface ReviewValidation {
  readonly accepted: boolean;
  readonly refusals: readonly ReviewRefusal[];
  /** Whether the stored data rule was checked: false when the contract diff was not known. */
  readonly storedDataChecked: boolean;
}

function checkEvidence(
  value: string,
  files: ReadonlyMap<string, string | null>,
  invariant: string | undefined,
): { refusal: ReviewRefusal | null; evidence: Evidence | undefined } {
  const evidence = parseEvidence(value);
  const at = invariant === undefined ? {} : { invariant };
  if (evidence === undefined) {
    return {
      evidence,
      refusal: {
        code: "invalid_evidence",
        ...at,
        evidence: value,
        message: 'evidence must be a test or definition ("path::name", "path::Class::name") or a line ("path:line") in the fork',
      },
    };
  }
  const problem = evidenceProblem(evidence, files.get(evidence.path) ?? null);
  return { evidence, refusal: problem === null ? null : { code: "evidence_not_found", ...at, evidence: value, message: problem } };
}

/**
 * Checks a form against the reviewing scope's invariants and the fork. It is refused with every
 * reason found: a missing, unknown or repeated row; a row without evidence; evidence that is
 * malformed or does not exist in the fork; "unknown" without a test behind it; and a stored data
 * shape change without a migration, backfill or cutover marker. Deterministic: the same form, files
 * and diff give the same result.
 */
export function validateReviewForm(input: ReviewValidationInput): ReviewValidation {
  const { form, invariants, files } = input;
  const refusals: ReviewRefusal[] = [];
  const known = new Set(invariants.map((invariant) => invariant.id));
  const seen = new Set<string>();
  for (const row of form.rows) {
    if (!known.has(row.invariant)) {
      refusals.push({ code: "unknown_invariant", invariant: row.invariant, message: "the reviewing scope declares no such invariant" });
      continue;
    }
    if (seen.has(row.invariant)) {
      refusals.push({ code: "duplicate_row", invariant: row.invariant, message: "the form has two rows for this invariant" });
      continue;
    }
    seen.add(row.invariant);
    if (row.evidence.length === 0) {
      refusals.push({ code: "no_evidence", invariant: row.invariant, message: `a "${row.verdict}" verdict needs evidence in the fork` });
      continue;
    }
    let tests = 0;
    for (const value of row.evidence) {
      const { evidence, refusal } = checkEvidence(value, files, row.invariant);
      if (refusal !== null) refusals.push(refusal);
      else if (evidence?.kind === "symbol" && evidence.test) tests += 1;
    }
    if (row.verdict === "unknown" && tests === 0) {
      refusals.push({ code: "unknown_without_test", invariant: row.invariant, message: '"unknown" needs a test in the fork behind it' });
    }
  }
  for (const invariant of invariants) {
    if (!seen.has(invariant.id)) {
      refusals.push({ code: "missing_row", invariant: invariant.id, message: "the form has no row for this invariant of the scope" });
    }
  }
  if (form.storedDataMarker !== null) {
    const { refusal } = checkEvidence(form.storedDataMarker.evidence, files, undefined);
    if (refusal !== null) refusals.push(refusal);
  }
  const storedDataChecked = input.storedShapes !== null;
  const rule = storedDataProblem(input.storedShapes ?? [], form.storedDataMarker, input.scope);
  if (rule !== null) refusals.push(rule);
  return { accepted: refusals.length === 0, refusals, storedDataChecked };
}

/**
 * The stored data rule for the reviewing scope's own stores (#132): when the contract diff shows a
 * stored data shape of `scope` changed, the scope persists data the change affects, so its part cannot
 * be approved without a migration, a backfill or a cutover marker in the form. A shape the scope only
 * reads is the owning change's to cover, and the routing reads it (`readOnlyShapes`). Null when it holds.
 */
export function storedDataProblem(shapes: readonly StoredShapeChange[], marker: StoredDataMarker | null, scope: string): ReviewRefusal | null {
  const own = shapes.filter((shape) => ownsShape(shape, scope));
  if (own.length === 0 || marker !== null) return null;
  const named = own.slice(0, 5).map((shape) => `${shape.symbol} (${shape.path})`).join(", ");
  return {
    code: "stored_data_without_marker",
    message: `the scope's own stored data changes shape (${named}${own.length > 5 ? ", ..." : ""}); name a migration, backfill or cutover marker`,
  };
}

// The side-by-side run: the reviewing scope's public functions on main and on the fork.

/** What one call did: returned a value (encoded as JSON) or raised an exception. */
export type SideBySideOutcome =
  | { readonly status: "returned"; readonly value: unknown }
  | { readonly status: "raised"; readonly error: { readonly type: string; readonly message: string } };

/** One input whose outcome differs between main and the fork. */
export interface SideBySideDifference {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly main: SideBySideOutcome;
  readonly fork: SideBySideOutcome;
}

/** One input that was not run: it does not fit the function's signature, or names no contract. */
export interface SideBySideInvalid {
  readonly name: string;
  /** Where it was refused: before any run, or by the signature on main, the fork or both. */
  readonly side: "request" | "main" | "fork" | "both";
  readonly reason: string;
}

/** The run of one contract over one examples file or the form's risky inputs. */
export interface SideBySideSet {
  readonly source: "examples" | "risky-inputs";
  /** The examples file on main; null for risky inputs. */
  readonly file: string | null;
  readonly contract: string;
  /** Invariants the set bears on. */
  readonly invariants: readonly string[];
  /** Every input's name, in order. */
  readonly inputs: readonly string[];
  readonly differing: readonly SideBySideDifference[];
  readonly invalid: readonly SideBySideInvalid[];
  /** Summed call time on each side. */
  readonly mainMs: number;
  readonly forkMs: number;
}

/** The record of one side-by-side run, kept so the feature page and demos can show it. */
export interface SideBySideRecord {
  readonly schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  readonly tool: typeof SIDE_BY_SIDE_TOOL;
  readonly commandId: typeof SIDE_BY_SIDE_COMMAND_ID;
  readonly base: string;
  readonly fork: string;
  readonly scope: string;
  readonly sets: readonly SideBySideSet[];
  readonly totals: { readonly inputs: number; readonly differing: number; readonly invalid: number };
  /** Wall time of each side's process and of the whole run. */
  readonly timings: { readonly mainMs: number; readonly forkMs: number; readonly totalMs: number };
}

/** One recorded example: a name and keyword arguments as JSON. */
export interface ExampleCase {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ExampleFile {
  readonly contract: string;
  readonly cases: readonly ExampleCase[];
}

const EXAMPLE_FILE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["contract", "cases"],
  properties: {
    $comment: { type: "string" },
    contract: text(512, 1),
    cases: {
      type: "array",
      maxItems: REVIEW_LIMITS.examplesPerFile,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "args"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: REVIEW_LIMITS.nameLength, pattern: NAME_PATTERN },
          args: { type: "object" },
        },
      },
    },
  },
};

/**
 * Parses a recorded examples file: `{ "contract": "path::symbol", "cases": [{ "name", "args" }] }`.
 *
 * Raises:
 *   Error: naming the first problems, when the file breaks the format or repeats a case name.
 */
export function parseExampleFile(value: unknown): ExampleFile {
  const errors = checkSchema(EXAMPLE_FILE_SCHEMA, value);
  if (errors.length > 0) {
    throw new Error(errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`).join("; "));
  }
  const file = value as ExampleFile;
  const names = file.cases.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new Error("/cases names must be unique");
  return { contract: file.contract, cases: file.cases };
}

/** A reason the scope's owner sees the review in person (PRD 0.4 sections 4.3 and 7). */
export type ReviewException =
  | { readonly kind: "broken_invariant"; readonly invariant: string; readonly scope: string }
  | { readonly kind: "protected_difference"; readonly invariant: string; readonly scope: string; readonly contract: string; readonly differing: number };

/**
 * The exceptions a review raises, for the plan's routing: each invariant an accepted form reports
 * broken, and each protected invariant a side-by-side set bearing on it shows a difference for.
 * Empty means the agent's review stands without the owner. Pass a refused form as null: it goes
 * back to its agent, while a protected difference reaches the owner whatever the form says.
 */
export function reviewExceptions(
  form: ReviewForm | null,
  invariants: readonly InvariantView[],
  sideBySide: SideBySideRecord | null,
): ReviewException[] {
  const byId = new Map(invariants.map((invariant) => [invariant.id, invariant]));
  const exceptions: ReviewException[] = [];
  for (const row of form?.rows ?? []) {
    const invariant = byId.get(row.invariant);
    if (row.verdict === "breaks" && invariant !== undefined) {
      exceptions.push({ kind: "broken_invariant", invariant: invariant.id, scope: invariant.scopeId });
    }
  }
  const counted = new Map<string, number>();
  for (const set of sideBySide?.sets ?? []) {
    if (set.differing.length === 0) continue;
    for (const id of set.invariants) {
      const invariant = byId.get(id);
      if (invariant === undefined || !invariant.protected) continue;
      const key = `${id}\u0000${set.contract}`;
      counted.set(key, (counted.get(key) ?? 0) + set.differing.length);
    }
  }
  for (const [key, differing] of counted) {
    const [id, contract] = key.split("\u0000") as [string, string];
    exceptions.push({ kind: "protected_difference", invariant: id, scope: (byId.get(id) as InvariantView).scopeId, contract, differing });
  }
  return exceptions;
}

// The review record: what the check runner reports for one submitted review (`penguin-bridge review`
// and runner mode). The ProjectAgent keeps it with the review and derives the routing from it.

/** One review on the check runner: the form checked again, the stored data rule and the side-by-side run. */
export interface ReviewRecord {
  readonly schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  readonly base: string;
  readonly fork: string;
  readonly scope: string;
  readonly state: "accepted" | "refused";
  readonly refusals: readonly ReviewRefusal[];
  /** The scope's invariants the form was checked against. */
  readonly invariants: readonly InvariantView[];
  /**
   * The changed stored data shapes the reviewing scope reads or owns, each with the scope that owns
   * it; null when no diff was made.
   */
  readonly storedShapes: readonly StoredShapeChange[] | null;
  readonly sideBySide: SideBySideRecord;
  /** What goes to the scope's owner in person; empty when the agent's review stands. */
  readonly exceptions: readonly ReviewException[];
  readonly timings: { readonly impactMs: number; readonly sideBySideMs: number; readonly totalMs: number };
}

const COMMIT = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const LINE = text(4_096);
const ID = text(128, 1);
const MS = { type: "number", minimum: 0 };
const COUNT = { type: "integer", minimum: 0 };
const object = (properties: Record<string, JsonSchema>, optional: readonly string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  properties,
});
const array = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", maxItems, items });
const OUTCOME: JsonSchema = {
  oneOf: [
    object({ status: { const: "returned" }, value: {} }),
    object({ status: { const: "raised" }, error: object({ type: LINE, message: LINE }) }),
  ],
};
const NAME = text(REVIEW_LIMITS.nameLength, 1);
const INPUTS_PER_SET = REVIEW_LIMITS.examplesPerFile + REVIEW_LIMITS.riskyInputs;

/** JSON Schema (draft 2020-12) of one side-by-side run as the runner reports it. */
export const SIDE_BY_SIDE_RECORD_SCHEMA: JsonSchema = object({
  schemaVersion: { const: REVIEW_SCHEMA_VERSION },
  tool: { const: SIDE_BY_SIDE_TOOL },
  commandId: { const: SIDE_BY_SIDE_COMMAND_ID },
  base: COMMIT,
  fork: COMMIT,
  scope: ID,
  sets: array(
    object({
      source: { type: "string", enum: ["examples", "risky-inputs"] },
      file: { anyOf: [{ type: "null" }, text(1_024, 1)] },
      contract: text(512, 1),
      invariants: array(ID, 1_000),
      inputs: array(NAME, INPUTS_PER_SET),
      differing: array(object({ name: NAME, args: { type: "object" }, main: OUTCOME, fork: OUTCOME }), INPUTS_PER_SET),
      invalid: array(object({ name: NAME, side: { type: "string", enum: ["request", "main", "fork", "both"] }, reason: LINE }), INPUTS_PER_SET),
      mainMs: MS,
      forkMs: MS,
    }),
    1_000,
  ),
  totals: object({ inputs: COUNT, differing: COUNT, invalid: COUNT }),
  timings: object({ mainMs: MS, forkMs: MS, totalMs: MS }),
});

/** JSON Schema (draft 2020-12) of a review record as the runner reports it. */
export const REVIEW_RECORD_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin review record",
  ...object({
    schemaVersion: { const: REVIEW_SCHEMA_VERSION },
    base: COMMIT,
    fork: COMMIT,
    scope: ID,
    state: { type: "string", enum: ["accepted", "refused"] },
    refusals: array(
      object({ code: { type: "string", enum: [...REVIEW_REFUSAL_CODES] }, message: LINE, invariant: LINE, evidence: LINE }, ["invariant", "evidence"]),
      REVIEW_LIMITS.rows * (REVIEW_LIMITS.evidencePerRow + 1) + 20,
    ),
    invariants: array(object({ id: ID, scopeId: ID, statement: text(500), protected: { type: "boolean" } }), 1_000),
    storedShapes: { anyOf: [{ type: "null" }, array(object({ symbol: LINE, path: LINE, scope: { anyOf: [{ type: "null" }, ID] } }, ["scope"]), 2_000)] },
    sideBySide: SIDE_BY_SIDE_RECORD_SCHEMA,
    exceptions: array(
      {
        oneOf: [
          object({ kind: { const: "broken_invariant" }, invariant: ID, scope: ID }),
          object({ kind: { const: "protected_difference" }, invariant: ID, scope: ID, contract: text(512, 1), differing: COUNT }),
        ],
      },
      2_000,
    ),
    timings: object({ impactMs: MS, sideBySideMs: MS, totalMs: MS }),
  }),
};

export type ParsedReviewRecord = { readonly ok: true; readonly record: ReviewRecord } | { readonly ok: false; readonly problems: string[] };

/** Checks a reported review record's size and shape. The ProjectAgent checks it belongs to the review. */
export function parseReviewRecord(value: unknown): ParsedReviewRecord {
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  if (bytes > REVIEW_LIMITS.recordBytes) return { ok: false, problems: [`the record is over ${REVIEW_LIMITS.recordBytes} bytes of JSON`] };
  const errors = checkSchema(REVIEW_RECORD_SCHEMA, value);
  if (errors.length > 0) return { ok: false, problems: errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`) };
  const record = value as ReviewRecord;
  const { sideBySide } = record;
  if (sideBySide.base !== record.base || sideBySide.fork !== record.fork || sideBySide.scope !== record.scope) {
    return { ok: false, problems: ["/sideBySide names other commits or another scope than the record"] };
  }
  return { ok: true, record };
}

/**
 * The record as the runner reports it. One over REVIEW_LIMITS.recordBytes keeps the first
 * REVIEW_LIMITS.recordedPerSet differing and not-run inputs of each set, so it fits one stored row;
 * `inputs` and `totals` still count every input.
 */
export function boundReviewRecord(record: ReviewRecord): ReviewRecord {
  if (new TextEncoder().encode(JSON.stringify(record)).length <= REVIEW_LIMITS.recordBytes) return record;
  const limit = REVIEW_LIMITS.recordedPerSet;
  const sets = record.sideBySide.sets.map((set) => ({ ...set, differing: set.differing.slice(0, limit), invalid: set.invalid.slice(0, limit) }));
  return { ...record, sideBySide: { ...record.sideBySide, sets } };
}

/** A side-by-side run reported on its own, bound the way `boundReviewRecord` bounds the one in a review. */
export function boundSideBySideRecord(record: SideBySideRecord): SideBySideRecord {
  if (new TextEncoder().encode(JSON.stringify(record)).length <= REVIEW_LIMITS.recordBytes) return record;
  const limit = REVIEW_LIMITS.recordedPerSet;
  return { ...record, sets: record.sets.map((set) => ({ ...set, differing: set.differing.slice(0, limit), invalid: set.invalid.slice(0, limit) })) };
}

const outcomeText = (outcome: SideBySideOutcome): string =>
  outcome.status === "returned" ? JSON.stringify(outcome.value) : `raised ${outcome.error.type}: ${outcome.error.message}`;

/** The run as text for a terminal, a feature page or the walkthrough. */
export function formatSideBySide(record: SideBySideRecord): string {
  const { totals, timings } = record;
  const lines = [
    `${record.tool} (${record.commandId}) scope ${record.scope}, main ${record.base.slice(0, 12)} vs fork ${record.fork.slice(0, 12)}: ` +
      `${totals.differing} of ${totals.inputs} inputs differ, ${totals.invalid} not run ` +
      `(main ${Math.round(timings.mainMs)} ms, fork ${Math.round(timings.forkMs)} ms)`,
  ];
  for (const set of record.sets) {
    const from = set.file ?? "the form's risky inputs";
    const bears = set.invariants.length > 0 ? `, invariants ${set.invariants.join(", ")}` : "";
    lines.push(`  ${set.contract} on ${from}: differs on ${set.differing.length} of ${set.inputs.length}${bears}`);
    for (const difference of set.differing) {
      lines.push(`    ${difference.name}: main ${outcomeText(difference.main)}; fork ${outcomeText(difference.fork)}`);
    }
    for (const invalid of set.invalid) lines.push(`    ${invalid.name}: not run (${invalid.side}): ${invalid.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
