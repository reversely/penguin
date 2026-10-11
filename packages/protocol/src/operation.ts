// The issue operation envelope, its file path and its op_id rule. See operation-schema.ts for the schema.

import {
  MAX_OPERATION_FILE_BYTES,
  OPERATION_SCHEMA,
  OPERATION_SCHEMA_VERSION,
  OP_ID_PATTERN,
  PENGUIN_AUTHOR_SEGMENT,
  type OperationType,
} from "./operation-schema.ts";
import { checkSchema, type SchemaError } from "./schema-check.ts";

export type Party = { readonly person: string } | { readonly identity: string };
export type Author = Party | { readonly penguin: true };
export type IssueId = number | string;

export interface Operation {
  readonly schema_version: typeof OPERATION_SCHEMA_VERSION;
  readonly op_id: string;
  readonly issue: IssueId;
  readonly type: OperationType;
  readonly author: Author;
  readonly base_version: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signature: string;
}

export type UnsignedOperation = Omit<Operation, "signature">;

export type ValidationResult =
  | { readonly ok: true; readonly operation: Operation }
  | { readonly ok: false; readonly errors: SchemaError[] };

const OP_ID = new RegExp(OP_ID_PATTERN, "u");

/**
 * The author's file-name segment: a person's ID, an identity handle "@owner/name" as "owner.name",
 * or "penguin". Person IDs and handle halves contain no dots, so the mapping never collides.
 */
export function authorSegment(author: Author): string {
  if ("person" in author) return author.person;
  if ("identity" in author) return author.identity.slice(1).replace("/", ".");
  return PENGUIN_AUTHOR_SEGMENT;
}

/** The op_id for an author's `seq`th operation (starting at 1), for example "jun-0007". */
export function formatOpId(author: Author, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999_999) throw new RangeError(`invalid sequence number: ${seq}`);
  const opId = `${authorSegment(author)}-${String(seq).padStart(4, "0")}`;
  if (!OP_ID.test(opId)) throw new RangeError(`invalid op_id: ${opId}`);
  return opId;
}

/** The repo path of an operation file: issues/<issue>/ops/<op_id>.json. Throws on any unsafe segment. */
export function operationPath(operation: Pick<Operation, "issue" | "op_id">): string {
  const issue = String(operation.issue);
  const issueOk =
    typeof operation.issue === "number"
      ? Number.isSafeInteger(operation.issue) && operation.issue >= 1
      : OP_ID.test(issue);
  if (!issueOk) throw new RangeError(`invalid issue id: ${issue}`);
  if (!OP_ID.test(operation.op_id)) throw new RangeError(`invalid op_id: ${operation.op_id}`);
  return `issues/${issue}/ops/${operation.op_id}.json`;
}

/** Checks a parsed operation against the schema and the op_id rule. It does not check the signature. */
export function validateOperation(value: unknown): ValidationResult {
  const errors = checkSchema(OPERATION_SCHEMA, value);
  if (errors.length === 0) {
    const operation = value as Operation;
    const expected = `${authorSegment(operation.author)}-`;
    if (!operation.op_id.startsWith(expected) || !OP_ID.test(operation.op_id)) {
      errors.push({ path: "/op_id", message: `must begin with the author segment "${expected}"` });
    }
  }
  return errors.length === 0 ? { ok: true, operation: value as Operation } : { ok: false, errors };
}

/** Reads an operation file's bytes: enforces the size cap, then UTF-8, JSON and the schema. */
export function parseOperationFile(bytes: Uint8Array): ValidationResult {
  if (bytes.byteLength > MAX_OPERATION_FILE_BYTES) {
    return { ok: false, errors: [{ path: "", message: `file exceeds ${MAX_OPERATION_FILE_BYTES} bytes` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, errors: [{ path: "", message: "is not UTF-8 JSON" }] };
  }
  return validateOperation(value);
}
