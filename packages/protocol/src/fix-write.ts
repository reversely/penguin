// Writing an approved plan part's fix into the affected feature's fork (PRD 0.4 section 4.4 step 1,
// section 9 `FixWrite`).
//
// Once a part's author approves it, Penguin hands one writer a `FixWriteSpec` with a write token on the
// affected fork alone: the originating agent for a behavioural part, the check runner for a mechanical
// or verify one. The writer applies the part's patch to `parent`, the fork head, copies the originating
// change's modules the spec's `copy` names byte for byte (module-copy.ts), and pushes the result to the
// fork's `main` as one fast-forward commit with `message`. Penguin then reads the commit through the
// Artifacts binding and keeps a signed `fix_write` record of it only when the commit's parent, message
// and files are exactly the approved patch and the copies applied to `parent`.
//
// A rule write (#209) carries no patch: the spec's `rewrite` names the rewrite rules the originating
// agent stated for broken callers in the fork and the call sites' files they may change. The check
// runner applies the rules there with Penguin's codemod at `parent` and commits what they write with
// the copies. Penguin then keeps the commit only when it changes some of those files and the copies
// and nothing else.
//
// The commit message is built here from validated fields only: ids, a revision number, an identity
// handle and the fix's reference. No text an agent or a person wrote reaches it.

import { MODULE_COPY_LIMIT, type ModuleCopy } from "./module-copy.ts";
import { FEATURE_ID_MAX_LENGTH } from "./overlap.ts";
import { SEGMENT_PATTERN } from "./operation-schema.ts";
import { PATCH_LIMITS } from "./patch.ts";
import { PLAN_PART_KINDS, type PlanPartKind } from "./plan.ts";
import { REWRITE_RULE_KINDS, REWRITE_RULE_LIMITS, type RewriteRule } from "./rewrite-rule.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

/** The branch of a feature's fork that a fix fast-forwards. */
export const FIX_WRITE_BRANCH = "main";

/** Who pushes a part's fix: the originating agent (behavioural) or the check runner (mechanical). */
export const FIX_WRITERS = ["agent", "runner"] as const;
export type FixWriter = (typeof FIX_WRITERS)[number];

/** The writer of a mechanical part as commit messages and records name it. */
export const RUNNER_WRITER = "penguin";

/** What a writer needs to write one approved part's fix. */
export interface FixWriteSpec {
  readonly writeId: number;
  /** The originating feature, whose plan the part belongs to. */
  readonly feature: string;
  readonly planId: string;
  readonly partId: string;
  readonly revision: number;
  readonly kind: PlanPartKind;
  readonly writer: FixWriter;
  /** The affected feature, whose fork receives the fix. */
  readonly target: string;
  /** That feature's fork as bridges name it: `feature-<target>`. */
  readonly fork: string;
  readonly branch: typeof FIX_WRITE_BRANCH;
  /** The fork head the commit must fast-forward: the patch's base, or the head it was rebased onto. */
  readonly parent: string;
  /** True when the fork head moved past the patch's base and the patch still applies there unchanged. */
  readonly rebased: boolean;
  /** The files the patch writes; the commit changes these and the copies and nothing else. */
  readonly paths: readonly string[];
  /** The approved patch: the rules' rewrite of the fork's call sites, or an agent's fix. Empty when the write only copies. */
  readonly patch: string;
  /** The originating change's modules Penguin copies into the fork; absent when it copies none. */
  readonly copy?: ModuleCopy;
  /** For a rule write: the rules the runner applies and the files they may change; absent otherwise. */
  readonly rewrite?: FixRewrite;
  readonly message: string;
}

/** The rules of a rule write and where they apply (#209). */
export interface FixRewrite {
  /** The originating change's revision, which holds each rule's contract module. */
  readonly source: string;
  readonly rules: readonly RewriteRule[];
  /** The broken call sites' files: the only files the rules may change. */
  readonly paths: readonly string[];
}

/** The fields a fix commit's message is built from; every one is checked before it gets here. */
export interface FixMessageFields {
  readonly partId: string;
  readonly revision: number;
  readonly target: string;
  /** The person whose approval of the revision is recorded. */
  readonly approvedBy: string;
  /** The identity handle of the originating agent, or `penguin` for the check runner. */
  readonly writtenBy: string;
  /** The fix's reference in the plan: `feature-<id>@<base>+patch:sha256:<hex>`. */
  readonly ref: string;
  /** For a write that only copies the originating change's modules: the revision they come from. */
  readonly copiedFrom?: string;
}

/** The one commit message a fix may carry. */
export function fixCommitMessage(fields: FixMessageFields): string {
  if (fields.ref.startsWith("rules:")) {
    return [
      `fix(${fields.target}): rewrite broken call sites by rule (${fields.partId} revision ${fields.revision})`,
      "",
      `Rules approved by ${fields.approvedBy}.`,
      `Fix ${fields.ref}.`,
      `Written by ${fields.writtenBy}.`,
      "",
    ].join("\n");
  }
  if (fields.copiedFrom !== undefined) {
    return [
      `fix(${fields.target}): copy the originating modules of merge plan part ${fields.partId} revision ${fields.revision}`,
      "",
      `Part ${fields.partId} revision ${fields.revision}, approved by ${fields.approvedBy}.`,
      `Modules copied from ${fields.copiedFrom}.`,
      `Written by ${fields.writtenBy}.`,
      "",
    ].join("\n");
  }
  return [
    `fix(${fields.target}): write merge plan part ${fields.partId} revision ${fields.revision}`,
    "",
    `Part ${fields.partId} revision ${fields.revision}, approved by ${fields.approvedBy}.`,
    `Fix ${fields.ref}.`,
    `Written by ${fields.writtenBy}.`,
    "",
  ].join("\n");
}

const FEATURE_ID: JsonSchema = { type: "string", pattern: `^${SEGMENT_PATTERN}$`, maxLength: FEATURE_ID_MAX_LENGTH };
const SHA: JsonSchema = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };

/** JSON Schema (draft 2020-12) for a `FixWriteSpec` as a writer receives it. */
export const FIX_WRITE_SPEC_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin fix write",
  type: "object",
  additionalProperties: false,
  required: ["writeId", "feature", "planId", "partId", "revision", "kind", "writer", "target", "fork", "branch", "parent", "rebased", "paths", "patch", "message"],
  properties: {
    writeId: { type: "integer", minimum: 1 },
    feature: FEATURE_ID,
    planId: { type: "string", maxLength: 128 },
    partId: { type: "string", maxLength: 128 },
    revision: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: [...PLAN_PART_KINDS] },
    writer: { type: "string", enum: [...FIX_WRITERS] },
    target: FEATURE_ID,
    fork: { type: "string", pattern: `^feature-${SEGMENT_PATTERN}$`, maxLength: FEATURE_ID_MAX_LENGTH + 8 },
    branch: { const: FIX_WRITE_BRANCH },
    parent: SHA,
    rebased: { type: "boolean" },
    paths: { type: "array", maxItems: PATCH_LIMITS.files, items: { type: "string", minLength: 1, maxLength: PATCH_LIMITS.pathLength } },
    patch: { type: "string", maxLength: PATCH_LIMITS.bytes },
    copy: {
      type: "object",
      additionalProperties: false,
      required: ["source", "base", "paths"],
      properties: {
        source: SHA,
        base: SHA,
        paths: { type: "array", minItems: 1, maxItems: MODULE_COPY_LIMIT, items: { type: "string", minLength: 1, maxLength: PATCH_LIMITS.pathLength } },
      },
    },
    rewrite: {
      type: "object",
      additionalProperties: false,
      required: ["source", "rules", "paths"],
      properties: {
        source: SHA,
        rules: {
          type: "array",
          minItems: 1,
          maxItems: REWRITE_RULE_LIMITS.rules,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "contract", "kind", "pattern", "replacement", "imports"],
            properties: {
              id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: REWRITE_RULE_LIMITS.id },
              contract: { type: "string", minLength: 1, maxLength: 1_024 },
              kind: { type: "string", enum: [...REWRITE_RULE_KINDS] },
              pattern: { type: "string", minLength: 1, maxLength: REWRITE_RULE_LIMITS.text },
              replacement: { type: "string", minLength: 1, maxLength: REWRITE_RULE_LIMITS.text },
              imports: {
                type: "array",
                maxItems: REWRITE_RULE_LIMITS.imports,
                items: { type: "object", additionalProperties: false, required: ["module", "name"], properties: { module: { type: "string", minLength: 1, maxLength: 512 }, name: { type: "string", minLength: 1, maxLength: 128 } } },
              },
            },
          },
        },
        paths: { type: "array", minItems: 1, maxItems: PATCH_LIMITS.files, items: { type: "string", minLength: 1, maxLength: PATCH_LIMITS.pathLength } },
      },
    },
    message: { type: "string", minLength: 1, maxLength: 2_048 },
  },
};

/** Where a value breaks FIX_WRITE_SPEC_SCHEMA; empty when it is a valid spec. */
export function checkFixWriteSpec(value: unknown): SchemaError[] {
  return checkSchema(FIX_WRITE_SPEC_SCHEMA, value);
}
