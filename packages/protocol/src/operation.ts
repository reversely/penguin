// The issue operation envelope, its file path and its op_id rule, <author>-<writer>-<seq>. See
// operation-schema.ts for the schema.

import {
  MAX_OPERATION_FILE_BYTES,
  OPERATION_SCHEMA,
  OPERATION_SCHEMA_VERSION,
  OP_ID_PATTERN,
  PENGUIN_AUTHOR_SEGMENT,
  SEQ_PATTERN,
  WRITER_TAG_PATTERN,
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
const WRITER_TAG = new RegExp(`^${WRITER_TAG_PATTERN}$`, "u");
// The writer and the sequence number at the end of an op_id. Neither holds a hyphen, so the rest is
// the author segment however many hyphens it holds.
const OP_ID_TAIL = new RegExp(`-(${WRITER_TAG_PATTERN})-(${SEQ_PATTERN})$`, "u");

/** An op_id split into its parts. */
export interface OpIdParts {
  readonly segment: string;
  readonly writer: string;
  readonly seq: number;
}

/** Number of hexadecimal digits in a bridge's writer tag. */
const BRIDGE_TAG_LENGTH = 4;

/** The anchor of the thread Penguin opens for a review that requests changes: `review:<review op_id>`. */
export const REVIEW_THREAD_ANCHOR_PREFIX = "review:";

/** The anchor of the thread opened for the review `reviewOpId`. */
export function reviewThreadAnchor(reviewOpId: string): string {
  return `${REVIEW_THREAD_ANCHOR_PREFIX}${reviewOpId}`;
}

/** The op_id of the review a thread was opened for, or null when its anchor names no review. */
export function anchoredReview(anchor: string | null): string | null {
  if (anchor === null || !anchor.startsWith(REVIEW_THREAD_ANCHOR_PREFIX)) return null;
  return anchor.slice(REVIEW_THREAD_ANCHOR_PREFIX.length);
}

/**
 * The author's file-name segment: a person's ID, an identity handle "@owner/name" as "owner.name",
 * or "penguin". Person IDs and handle halves contain no dots, so the mapping never collides.
 */
export function authorSegment(author: Author): string {
  if ("person" in author) return author.person;
  if ("identity" in author) return author.identity.slice(1).replace("/", ".");
  return PENGUIN_AUTHOR_SEGMENT;
}

/**
 * The op_id of the `seq`th operation (starting at 1) that `writer` numbered for an author, for
 * example "jun-web-0007" from the Worker or "jun-b3f2-0007" from a bridge.
 */
export function formatOpId(author: Author, writer: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999_999) throw new RangeError(`invalid sequence number: ${seq}`);
  if (!WRITER_TAG.test(writer)) throw new RangeError(`invalid writer tag: ${writer}`);
  const opId = `${authorSegment(author)}-${writer}-${String(seq).padStart(4, "0")}`;
  if (!OP_ID.test(opId)) throw new RangeError(`invalid op_id: ${opId}`);
  return opId;
}

/** Splits an op_id into author segment, writer and sequence number; undefined for anything else. */
export function parseOpId(opId: string): OpIdParts | undefined {
  if (!OP_ID.test(opId)) return undefined;
  const tail = OP_ID_TAIL.exec(opId);
  if (tail === null) return undefined;
  return { segment: opId.slice(0, tail.index), writer: tail[1]!, seq: Number(tail[2]) };
}

/**
 * A bridge's writer tag: the first four hexadecimal digits of the SHA-256 of its bridge ID, for
 * example "b3f2". Hexadecimal never spells `web`, so a bridge and the Worker never share a tag.
 */
export async function bridgeWriterTag(bridgeId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bridgeId)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, BRIDGE_TAG_LENGTH);
}

/**
 * True for an issue's temporary ID: the op_id of the create operation of an issue a bridge created
 * without a number. When Penguin applies that create it assigns the issue the next number, and the
 * temporary ID resolves to it from then on. The operation files that name the temporary ID stay in
 * the folder issues/<temporary ID>/, since a file's path must match the issue it names.
 */
export function isTemporaryIssueId(issue: IssueId): issue is string {
  return typeof issue === "string";
}

/**
 * The repo path of an operation file: issues/<issue>/ops/<op_id>.json, where <issue> is the issue as
 * the operation names it, its number or its temporary ID. Throws on any unsafe segment.
 */
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
    const segment = authorSegment(operation.author);
    if (parseOpId(operation.op_id)?.segment !== segment) {
      errors.push({ path: "/op_id", message: `must be "${segment}-<writer>-<seq>" for this author` });
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
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, errors: [{ path: "", message: "is not UTF-8 JSON" }] };
  }
  return validateOperation(value);
}
