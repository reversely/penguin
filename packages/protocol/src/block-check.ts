// The checks the check runner runs on each merged tree of a block (PRD section 5.1), and the
// dependency diff its Python analysis writes (`services/local-bridge/analysis/python_dependencies.py`).
//
// One `BlockCheck` is one check on one target: the originating checkpoint merged onto main or onto
// one affected fork's checkpoint. Each running feature's fork is a target of its own, keyed by the
// feature id, so one person's two features are two targets (PRD 0.4 section 1). It records the tool that ran, what it ran on and what it found,
// so a feature page or a walkthrough can show the facts behind each result. A check never carries a
// raw log; `logRef` names the log the runner kept by its SHA-256.

import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";
import { COMMAND_ID_PATTERN, FINGERPRINT_PATTERN } from "./operation-schema.ts";

/**
 * The section 5.1 checks. `retiring` is the retiring-calls check (retiring.ts): it runs on a
 * checkpoint's own changes, never on a merged tree of a block.
 */
export const BLOCK_CHECK_NAMES = ["overlap", "merge", "lint", "format", "dependencies", "typecheck", "tests", "retiring"] as const;
export type BlockCheckName = (typeof BLOCK_CHECK_NAMES)[number];

/**
 * `passed` and `failed` are facts about the merged tree. `not-affected`: the impact graph shows the
 * target uses nothing the change touches, so the check did not run. `not-run`: an earlier check
 * (a merge conflict) left nothing to check. `error`: the tool could not produce a result.
 */
export const BLOCK_CHECK_RESULTS = ["passed", "failed", "not-affected", "not-run", "error"] as const;
export type BlockCheckResult = (typeof BLOCK_CHECK_RESULTS)[number];

/** The target that stands for main: the originating checkpoint merged onto main's commit. */
export const MAIN_TARGET = "main";

/** Command IDs of the runner's own check tools. Each maps to a fixed program in the bridge. */
export const CHECK_COMMAND_IDS = {
  overlap: "git:diff-hunks",
  merge: "git:merge-tree",
  lint: "check:ruff-lint",
  format: "check:ruff-format",
  dependencies: "analysis:python-dependencies",
  typecheck: "check:pyright",
} as const;

/** Limits that keep the checks of one run small enough for one report and one SQL row each. */
export const BLOCK_CHECK_LIMITS = {
  checks: 7 * 65,
  findingsPerCheck: 20,
  messageLength: 300,
  pathLength: 1_024,
} as const;

/** One fact a check found: a file and line when the tool names one, a rule code, and the message. */
export interface BlockCheckFinding {
  readonly path: string | null;
  readonly line: number | null;
  readonly code: string | null;
  readonly message: string;
}

export interface BlockCheckFingerprint {
  readonly id: string;
  readonly commit: string;
  readonly lockfileHash: string;
  readonly commandId: string;
}

export interface BlockCheck {
  /** The merge plan the block belongs to; null for a combined run that no plan scheduled. */
  readonly planId: string | null;
  /**
   * `main`, or the fork the originating checkpoint was merged onto: a running feature's id, or a
   * person's id for their owner fork.
   */
  readonly target: string;
  readonly check: BlockCheckName;
  readonly result: BlockCheckResult;
  /** What ran: the tool, its version when the tool reports one, and its command ID. */
  readonly tool: { readonly name: string; readonly version: string | null; readonly commandId: string };
  /** What it ran on: the originating checkpoint, the target's commit and the merged commit. */
  readonly input: {
    readonly origin: string;
    readonly target: string;
    readonly merged: string | null;
    /** The files the tool read, when it read a chosen set; null for the whole tree. */
    readonly paths: readonly string[] | null;
  };
  /** The first findings, in the tool's order. */
  readonly findings: readonly BlockCheckFinding[];
  /** Every finding, including those past the limit. */
  readonly findingCount: number;
  /** One line that says what the check found. */
  readonly summary: string;
  /** Present when a tool ran on a merged commit. */
  readonly fingerprint: BlockCheckFingerprint | null;
  /** `sha256:<hex>` of the tool's output kept on the runner, or null when no tool ran. */
  readonly logRef: string | null;
  readonly durationMs: number;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const COMMAND_ID = { type: "string", pattern: `^${COMMAND_ID_PATTERN}$`, maxLength: 64 };
const PATH = { type: "string", minLength: 1, maxLength: BLOCK_CHECK_LIMITS.pathLength };
const SHORT = { type: "string", minLength: 1, maxLength: 128 };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const record = (properties: Record<string, JsonSchema>, optional: readonly string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  properties,
});
const list = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", maxItems, items });

/** JSON Schema (draft 2020-12) for one block check as it crosses the network. */
export const BLOCK_CHECK_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin block check",
  ...record({
    planId: nullable(SHORT),
    target: { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$", maxLength: 64 },
    check: { type: "string", enum: [...BLOCK_CHECK_NAMES] },
    result: { type: "string", enum: [...BLOCK_CHECK_RESULTS] },
    tool: record({ name: SHORT, version: nullable(SHORT), commandId: COMMAND_ID }),
    input: record({
      origin: SHA,
      target: SHA,
      merged: nullable(SHA),
      paths: nullable(list(PATH, 2_000)),
    }),
    findings: list(
      record({
        path: nullable(PATH),
        line: nullable({ type: "integer", minimum: 0 }),
        code: nullable(SHORT),
        message: { type: "string", maxLength: BLOCK_CHECK_LIMITS.messageLength },
      }),
      BLOCK_CHECK_LIMITS.findingsPerCheck,
    ),
    findingCount: { type: "integer", minimum: 0 },
    summary: { type: "string", maxLength: BLOCK_CHECK_LIMITS.messageLength },
    fingerprint: nullable(
      record({
        id: { type: "string", pattern: `^${FINGERPRINT_PATTERN}$` },
        commit: SHA,
        lockfileHash: { type: "string", pattern: `^${FINGERPRINT_PATTERN}$` },
        commandId: COMMAND_ID,
      }),
    ),
    logRef: nullable({ type: "string", pattern: `^sha256:${FINGERPRINT_PATTERN}$` }),
    durationMs: { type: "integer", minimum: 0 },
  }),
};

/** Where a value breaks BLOCK_CHECK_SCHEMA; empty when it is a valid block check. */
export function checkBlockCheck(value: unknown): SchemaError[] {
  return checkSchema(BLOCK_CHECK_SCHEMA, value);
}

// The dependency diff.

export const DEPENDENCY_SCHEMA_VERSION = 1;
export const DEPENDENCY_TOOL = "python-dependencies";
export const DEPENDENCY_COMMAND_ID = CHECK_COMMAND_IDS.dependencies;
const DEPENDENCY_MAX_ITEMS = 2_000;

/** Where a library's version was read from. */
export const DEPENDENCY_SOURCES = ["pyproject.toml", "requirements", "uv.lock", "vendored"] as const;

export interface DependencyChange {
  /** The normalised distribution name, or for vendored code the module that exposes `__version__`. */
  readonly library: string;
  readonly source: (typeof DEPENDENCY_SOURCES)[number];
  /** The manifest, lockfile or module that states the version. */
  readonly path: string;
  /** The version or specifier before and after; null when the library was added or removed. */
  readonly before: string | null;
  readonly after: string | null;
  /** The modules an import of the library names. */
  readonly modules: readonly string[];
  /** For vendored code: the module whose `__version__` literal was exposed before and after. */
  readonly origin?: { readonly before: string | null; readonly after: string | null };
}

export interface DependencyUse {
  readonly path: string;
  readonly line: number;
  readonly library: string;
  /** The module the import names. */
  readonly module: string;
}

export interface DependencyReport {
  readonly schemaVersion: typeof DEPENDENCY_SCHEMA_VERSION;
  readonly tool: typeof DEPENDENCY_TOOL;
  readonly commandId: typeof DEPENDENCY_COMMAND_ID;
  readonly base: string;
  readonly head: string;
  readonly changes: readonly DependencyChange[];
  readonly forks: readonly {
    readonly id: string;
    readonly sha: string;
    readonly scopes: readonly string[];
    readonly uses: readonly DependencyUse[];
  }[];
  readonly errors: readonly { readonly kind: string; readonly path: string; readonly message: string; readonly tree: string }[];
}

const TEXT = { type: "string", maxLength: 4_096 };
const NAME = { type: "string", minLength: 1, maxLength: 1_024 };
const ANY_PATH = { type: "string", maxLength: 1_024 };
const items = (schema: JsonSchema) => list(schema, DEPENDENCY_MAX_ITEMS);

/** JSON Schema (draft 2020-12) for one dependency diff report. */
export const DEPENDENCY_REPORT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin dependency diff",
  ...record({
    schemaVersion: { const: DEPENDENCY_SCHEMA_VERSION },
    tool: { const: DEPENDENCY_TOOL },
    commandId: { const: DEPENDENCY_COMMAND_ID },
    base: SHA,
    head: SHA,
    changes: items(
      record(
        {
          library: NAME,
          source: { type: "string", enum: [...DEPENDENCY_SOURCES] },
          path: NAME,
          before: nullable(TEXT),
          after: nullable(TEXT),
          modules: items(NAME),
          origin: record({ before: nullable(NAME), after: nullable(NAME) }),
        },
        ["origin"],
      ),
    ),
    forks: list(
      record({
        id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        sha: SHA,
        scopes: items(TEXT),
        uses: items(record({ path: NAME, line: { type: "integer", minimum: 1 }, library: NAME, module: NAME })),
      }),
      256,
    ),
    errors: items(record({ kind: NAME, path: ANY_PATH, message: TEXT, tree: NAME })),
  }),
};

/** Where a value breaks DEPENDENCY_REPORT_SCHEMA; empty when it is a valid report. */
export function checkDependencyReport(value: unknown): SchemaError[] {
  return checkSchema(DEPENDENCY_REPORT_SCHEMA, value);
}
