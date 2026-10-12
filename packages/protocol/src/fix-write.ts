// Writing an approved plan part's fix into the affected feature's fork (PRD 0.4 section 4.4 step 1,
// section 9 `FixWrite`).
//
// Once a part's author approves it, Penguin hands one writer a `FixWriteSpec` with a write token on the
// affected fork alone: the originating agent for a behavioural part, the check runner for a mechanical
// one. The writer applies the part's patch to `parent`, the fork head, as one commit with `message`,
// and pushes it to the fork's `main` as a fast-forward. Penguin then reads the commit through the
// Artifacts binding and keeps a signed `fix_write` record of it only when the commit's parent, message
// and files are exactly the approved patch applied to `parent`.
//
// The commit message is built here from validated fields only: ids, a revision number, an identity
// handle and the fix's reference. No text an agent or a person wrote reaches it.

import { FEATURE_ID_MAX_LENGTH } from "./overlap.ts";
import { SEGMENT_PATTERN } from "./operation-schema.ts";
import { PATCH_LIMITS } from "./patch.ts";
import { PLAN_PART_KINDS, type PlanPartKind } from "./plan.ts";
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
  /** The files the patch writes; the commit changes these and nothing else. */
  readonly paths: readonly string[];
  /** The approved patch, as the originating agent submitted it. */
  readonly patch: string;
  readonly message: string;
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
}

/** The one commit message a fix may carry. */
export function fixCommitMessage(fields: FixMessageFields): string {
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
    paths: { type: "array", minItems: 1, maxItems: PATCH_LIMITS.files, items: { type: "string", minLength: 1, maxLength: PATCH_LIMITS.pathLength } },
    patch: { type: "string", minLength: 1, maxLength: PATCH_LIMITS.bytes },
    message: { type: "string", minLength: 1, maxLength: 2_048 },
  },
};

/** Where a value breaks FIX_WRITE_SPEC_SCHEMA; empty when it is a valid spec. */
export function checkFixWriteSpec(value: unknown): SchemaError[] {
  return checkSchema(FIX_WRITE_SPEC_SCHEMA, value);
}
