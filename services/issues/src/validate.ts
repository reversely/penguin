// Decides whether one issue operation counts: its form, its signature, the binding between the
// signing key and the author, its base version, the author's rights and, for an identity, its
// charter (PRD sections 4, 5 and 12).
// The function reads no file and no network, so the Node bridge and the Workers runtime both run it.
// It never throws on any input: every problem with an operation becomes a rejection with a reason.

import { operationTargets, reviewRight, withinCharter, type CharterIdentity } from "@penguin/policies";
import {
  operationPath,
  parseOperationFile,
  validateOperation,
  type Author,
  type Operation,
  type SchemaError,
  type ValidationResult,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { issueKey } from "./reduce.ts";
import { verifyOperation } from "./signature.ts";

export const REJECT_REASONS = [
  /** Not UTF-8 JSON, over the size cap, or outside the operation schema (unknown fields included). */
  "malformed",
  /** The file sits at a path other than issues/<issue>/ops/<op_id>.json. */
  "wrong_path",
  /** The signature is missing, malformed, or verifies under no registered key. */
  "bad_signature",
  /** A registered key signed it, but that key may not write as the operation's author. */
  "author_not_bound",
  /** The base version is older than the issue's current version. */
  "superseded_version",
  /** The base version is newer than the issue's current version. */
  "unknown_version",
  /** The author has no right to perform this operation. */
  "no_right",
  /** An identity's operation names a scope or path outside the identity's charter. */
  "outside_charter",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

/** A registered bridge's verifying key and the one human owner the bridge belongs to. */
export interface BridgeKey {
  readonly bridgeId: string;
  readonly ownerId: string;
  readonly publicKey: CryptoKey;
}

/** The current state of the operation's issue in the index. */
export interface IssueState {
  /** The number of operations applied to the issue. */
  readonly version: number;
  readonly labels: readonly string[];
}

/** The identity records the charter check reads. */
export interface IdentityLookup {
  /** The identity with this handle, or undefined when none is stored. */
  identity(handle: string): CharterIdentity | undefined;
  /** The owner who assigned the identity to the issue, or undefined when it is not assigned there now. */
  assigningOwner(issueId: string, handle: string): string | undefined;
}

export interface ValidationContext {
  readonly bridges: readonly BridgeKey[];
  /** Penguin's service key, which signs operations from MCP, the dashboard and Penguin itself. */
  readonly serviceKey: CryptoKey;
  /** The operation's issue, or undefined when the index holds no such issue yet (version 0). */
  readonly issue: IssueState | undefined;
  readonly appliedOpIds: ReadonlySet<string>;
  readonly scopeMap: ScopeMap;
  /** Read only for an operation an identity authors that names a scope or path. */
  readonly identities: IdentityLookup;
  /** The repo path the operation was read from. When given, it must match the operation. */
  readonly path?: string;
}

export type Signer =
  | { readonly kind: "bridge"; readonly bridgeId: string; readonly ownerId: string }
  | { readonly kind: "service" };

export type Verdict =
  | { readonly status: "accepted"; readonly operation: Operation; readonly signer: Signer }
  /** The op_id is already applied. The caller writes no second record. */
  | { readonly status: "duplicate"; readonly opId: string }
  | {
      readonly status: "rejected";
      readonly reason: RejectReason;
      readonly message: string;
      /** The parsed operation, present once the file passed the schema. */
      readonly operation?: Operation;
    };

/**
 * Validate one operation. `input` is the operation file's bytes (or text), or an already parsed
 * JSON value. Checks run in this order: form, path, duplicate, signature, author binding, base
 * version, rights, charter. The first failing check gives the reason.
 */
export async function validate(input: unknown, context: ValidationContext): Promise<Verdict> {
  try {
    return await validateUnsafe(input, context);
  } catch (error) {
    // A defect in a check must not take the consumer down; the operation stays in the log as rejected.
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "rejected", reason: "malformed", message: `could not be validated: ${detail}` };
  }
}

async function validateUnsafe(input: unknown, context: ValidationContext): Promise<Verdict> {
  const parsed = parse(input);
  if (!parsed.ok) {
    const message = parsed.errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ");
    // PRD section 12 names a missing signature beside a bad one, so it takes the signature reason.
    const reason = parsed.errors.every(isSignatureError) ? "bad_signature" : "malformed";
    return { status: "rejected", reason, message };
  }
  const operation = parsed.operation;
  const reject = (reason: RejectReason, message: string): Verdict => ({ status: "rejected", reason, message, operation });

  if (context.path !== undefined) {
    const expected = operationPath(operation);
    if (context.path !== expected) return reject("wrong_path", `stored at ${context.path}, expected ${expected}`);
  }

  if (context.appliedOpIds.has(operation.op_id)) return { status: "duplicate", opId: operation.op_id };

  const signer = await findSigner(operation, context);
  if (signer === undefined) return reject("bad_signature", "the signature verifies under no registered key");

  const bindingError = authorBindingError(operation.author, signer);
  if (bindingError !== undefined) return reject("author_not_bound", bindingError);

  const version = context.issue?.version ?? 0;
  if (operation.base_version < version) {
    return reject("superseded_version", `based on version ${operation.base_version}; the issue is at version ${version}`);
  }
  if (operation.base_version > version) {
    return reject("unknown_version", `based on version ${operation.base_version}; the issue is at version ${version}`);
  }

  if (operation.type === "review") {
    const right = reviewRight(operation.author, context.issue?.labels ?? [], context.scopeMap);
    if (!right.allowed) return reject("no_right", right.message);
  }

  if ("identity" in operation.author) {
    const charterError = charterCheck(operation, operation.author.identity, context);
    if (charterError !== undefined) return reject("outside_charter", charterError);
  }

  return { status: "accepted", operation, signer };
}

/**
 * The charter error for an identity's operation, or undefined when it names nothing outside the
 * charter. An operation that names no scope or path needs no charter, so it reads no identity.
 */
function charterCheck(operation: Operation, handle: string, context: ValidationContext): string | undefined {
  const targets = operationTargets(operation);
  if (targets.scopes.length === 0 && targets.paths.length === 0) return undefined;
  const identity = context.identities.identity(handle);
  if (identity === undefined) return `${handle} has no charter: no identity with this handle is stored`;
  const assigner = context.identities.assigningOwner(issueKey(operation.issue), handle);
  const verdict = withinCharter(identity, assigner, targets.scopes, targets.paths, context.scopeMap);
  return verdict.allowed ? undefined : verdict.message;
}

function parse(input: unknown): ValidationResult {
  if (input instanceof Uint8Array) return parseOperationFile(input);
  if (typeof input === "string") return parseOperationFile(new TextEncoder().encode(input));
  return validateOperation(input);
}

function isSignatureError(error: SchemaError): boolean {
  return error.path === "/signature" || (error.path === "" && error.message === "must have property signature");
}

/**
 * Find the key that signed the operation. The operation does not name its key, so the likely keys
 * are tried first: the service key, then the bridges of the author's owner, then every other bridge,
 * so an operation signed by the wrong owner's bridge is reported as unbound rather than as forged.
 */
async function findSigner(operation: Operation, context: ValidationContext): Promise<Signer | undefined> {
  if (await verifyOperation(operation, context.serviceKey)) return { kind: "service" };
  const owner = authorOwner(operation.author);
  const ordered = [
    ...context.bridges.filter((bridge) => bridge.ownerId === owner),
    ...context.bridges.filter((bridge) => bridge.ownerId !== owner),
  ];
  for (const bridge of ordered) {
    if (await verifyOperation(operation, bridge.publicKey)) {
      return { kind: "bridge", bridgeId: bridge.bridgeId, ownerId: bridge.ownerId };
    }
  }
  return undefined;
}

/** The human owner an author acts for: the person, an identity's owner half, or none for Penguin. */
function authorOwner(author: Author): string | undefined {
  if ("person" in author) return author.person;
  if ("identity" in author) return author.identity.slice(1, author.identity.indexOf("/"));
  return undefined;
}

/**
 * The service key may write as anyone, because the Worker authenticates MCP and dashboard callers
 * before it signs. A bridge belongs to one owner and writes only as that owner or the owner's own
 * identities. Only the service key writes as Penguin.
 */
function authorBindingError(author: Author, signer: Signer): string | undefined {
  if (signer.kind === "service") return undefined;
  const owner = authorOwner(author);
  if (owner === signer.ownerId) return undefined;
  const who = "person" in author ? author.person : "identity" in author ? author.identity : "Penguin";
  return `signed by bridge ${signer.bridgeId} of ${signer.ownerId}, which cannot write as ${who}`;
}
