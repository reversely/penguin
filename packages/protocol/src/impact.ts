// The impact graph and contract diff the check runner's Python analysis writes for one change
// (`services/local-bridge/analysis/python_impact.py`). One report names the tool and its inputs (the
// base and head commits and each fork with its commit and scopes) and what it found: changed
// functions, methods, classes and values, changed signatures, removed exports, changed stored data
// shapes, and each import, call or reference of a changed symbol with its file and line.

import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

export const IMPACT_SCHEMA_VERSION = 1;
export const IMPACT_TOOL = "python-impact";
export const IMPACT_COMMAND_ID = "analysis:python-impact";

/** The most entries of one list in a report; the analysis truncates past it and says so. */
export const IMPACT_MAX_ITEMS = 2_000;

export const IMPACT_CHANGE_KINDS = ["modified", "added", "removed", "renamed", "moved"] as const;
export type ImpactChangeKind = (typeof IMPACT_CHANGE_KINDS)[number];
export const IMPACT_SYMBOL_KINDS = ["function", "method", "class", "variable", "alias"] as const;
export type ImpactSymbolKind = (typeof IMPACT_SYMBOL_KINDS)[number];
export const IMPACT_USE_KINDS = ["import", "call", "reference"] as const;
export type ImpactUseKind = (typeof IMPACT_USE_KINDS)[number];

export interface ImpactLocation {
  /** The dotted name, such as `pkg.module.Class.method`. */
  readonly symbol: string;
  /** The repository path of the file, and the line, where the name is defined or re-exported. */
  readonly path: string;
  readonly line: number;
}

export interface ImpactChange extends ImpactLocation {
  readonly kind: ImpactSymbolKind;
  readonly change: ImpactChangeKind;
  /** The scope whose paths hold the file, from `penguin/scopes.json`. */
  readonly scope: string | null;
  /** The declared contract (`path::symbol`) that covers the symbol, if any. */
  readonly contract: string | null;
  /** For a rename or a move: the new name and place. */
  readonly to?: ImpactLocation;
  /** For a re-export that now points at another definition: where it pointed before and after. */
  readonly origin?: { readonly before: string; readonly after: string };
}

export interface ImpactSignature extends ImpactLocation {
  readonly before: string;
  readonly after: string;
  readonly added: readonly { readonly name: string; readonly required: boolean }[];
  readonly removed: readonly string[];
  /** True when a call that worked before can fail now; `reasons` says why. */
  readonly breaking: boolean;
  readonly reasons: readonly string[];
}

export interface ImpactRemovedExport {
  readonly module: string;
  readonly path: string;
  readonly name: string;
}

export interface ImpactDataShape extends ImpactLocation {
  /** `dataclass`, `namedtuple`, `typeddict` or `enum`. */
  readonly kind: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly reordered: boolean;
}

export interface ImpactUse {
  readonly path: string;
  readonly line: number;
  readonly kind: ImpactUseKind;
  /** The changed symbol the use reaches. */
  readonly symbol: string;
  /** The name as the file spells it, before aliases are followed. */
  readonly name: string;
  readonly scope: string | null;
}

export interface ImpactError {
  readonly kind: string;
  readonly path: string;
  readonly message: string;
}

export interface ImpactFork {
  readonly id: string;
  readonly sha: string;
  readonly scopes: readonly string[];
  /** Uses of a changed symbol inside the fork's scopes. */
  readonly uses: readonly ImpactUse[];
  /** Files inside the fork's scopes the analysis could not read. */
  readonly errors: readonly ImpactError[];
}

export interface ImpactReport {
  readonly schemaVersion: typeof IMPACT_SCHEMA_VERSION;
  readonly tool: typeof IMPACT_TOOL;
  readonly commandId: typeof IMPACT_COMMAND_ID;
  readonly base: string;
  readonly head: string;
  readonly changes: readonly ImpactChange[];
  readonly signatures: readonly ImpactSignature[];
  readonly removedExports: readonly ImpactRemovedExport[];
  readonly dataShapes: readonly ImpactDataShape[];
  /** Declared contracts the change touches. */
  readonly contracts: readonly string[];
  /** Uses in the head tree outside the changed files: callers already on main. */
  readonly headUses: readonly ImpactUse[];
  readonly forks: readonly ImpactFork[];
  /** Changed paths the analysis could not see into: files other than parsed, importable modules. */
  readonly unanalysed: readonly string[];
  readonly errors: readonly (ImpactError & { readonly tree: string })[];
  /** True when every changed path was analysed and no list was truncated. */
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly files: { readonly base: number; readonly head: number; readonly parsed: number };
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const TEXT = { type: "string", maxLength: 4_096 };
const NAME = { type: "string", minLength: 1, maxLength: 1_024 };
const PATH = { type: "string", maxLength: 1_024 };
const LINE = { type: "integer", minimum: 1 };
const list = (items: JsonSchema): JsonSchema => ({ type: "array", maxItems: IMPACT_MAX_ITEMS, items });
const strings = list(TEXT);
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const record = (properties: Record<string, JsonSchema>, optional: readonly string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  properties,
});
const location = { symbol: NAME, path: PATH, line: LINE };
const error = { kind: NAME, path: PATH, message: TEXT };
const use = record({
  path: PATH,
  line: LINE,
  kind: { type: "string", enum: [...IMPACT_USE_KINDS] },
  symbol: NAME,
  name: NAME,
  scope: nullable(NAME),
});

/** JSON Schema (draft 2020-12) for one impact report. */
export const IMPACT_REPORT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin impact graph and contract diff",
  ...record({
    schemaVersion: { const: IMPACT_SCHEMA_VERSION },
    tool: { const: IMPACT_TOOL },
    commandId: { const: IMPACT_COMMAND_ID },
    base: SHA,
    head: SHA,
    changes: list(
      record(
        {
          ...location,
          kind: { type: "string", enum: [...IMPACT_SYMBOL_KINDS] },
          change: { type: "string", enum: [...IMPACT_CHANGE_KINDS] },
          scope: nullable(NAME),
          contract: nullable(NAME),
          to: record(location),
          origin: record({ before: NAME, after: NAME }),
        },
        ["to", "origin"],
      ),
    ),
    signatures: list(
      record({
        ...location,
        before: TEXT,
        after: TEXT,
        added: list(record({ name: NAME, required: { type: "boolean" } })),
        removed: strings,
        breaking: { type: "boolean" },
        reasons: strings,
      }),
    ),
    removedExports: list(record({ module: NAME, path: PATH, name: NAME })),
    dataShapes: list(
      record({
        ...location,
        kind: NAME,
        before: strings,
        after: strings,
        added: strings,
        removed: strings,
        changed: strings,
        reordered: { type: "boolean" },
      }),
    ),
    contracts: strings,
    headUses: list(use),
    forks: {
      type: "array",
      maxItems: 256,
      items: record({
        id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        sha: SHA,
        scopes: strings,
        uses: list(use),
        errors: list(record(error)),
      }),
    },
    unanalysed: list(PATH),
    errors: list(record({ ...error, tree: NAME })),
    complete: { type: "boolean" },
    truncated: { type: "boolean" },
    files: record({
      base: { type: "integer", minimum: 0 },
      head: { type: "integer", minimum: 0 },
      parsed: { type: "integer", minimum: 0 },
    }),
  }),
};

/** Where a value breaks IMPACT_REPORT_SCHEMA; empty when it is a valid report. */
export function checkImpactReport(value: unknown): SchemaError[] {
  return checkSchema(IMPACT_REPORT_SCHEMA, value);
}

/**
 * The forks whose tests must run for a change, in report order. A fork is selected when its scopes
 * import, call or reference a changed symbol, or when one of its files in those scopes could not
 * be read. When the report is incomplete (a changed path the analysis cannot see into, or a
 * truncated list), every fork is selected, because no fork can be shown to be unaffected.
 */
export function selectAffectedForks(report: ImpactReport): string[] {
  return report.forks
    .filter((fork) => !report.complete || fork.uses.length > 0 || fork.errors.length > 0)
    .map((fork) => fork.id);
}
