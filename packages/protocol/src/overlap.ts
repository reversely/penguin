// What GET /api/overlaps returns to the dashboard: the overlapping starts the signed-in person is told
// of or asked about (PRD 0.4 section 4.1 step 3). Each names the person's own running feature, the
// feature that started beside it and where the two areas meet. Since #177 Penguin lets every
// overlapping start open and tells the owner (`told`); only a lock opened before #177 still waits. An expand checkpoint that adds to a scope the
// person owns (PRD 0.5 section 4.2 step 2) waits the same way: its `feature` is then `owner:<person>`,
// since no feature of the person's need be running, and only the expand promotion waits. The ProjectAgent builds it from the
// person's overlap inbox items and the stored locks (services/project-agent/src/overlap-lock.ts); the
// Worker checks it against OVERLAP_REQUESTS_SCHEMA before answering.

import { PERSON_ID_MAX_LENGTH, PERSON_ID_PATTERN, SEGMENT_PATTERN } from "./operation-schema.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

export interface OverlapRequest {
  /** The person's own running feature, which covers the area, or `owner:<person>` for an expand into their scopes. */
  readonly feature: string;
  /** The feature whose start waits for the approval. */
  readonly blockedFeature: string;
  /** The person who owns the waiting feature. */
  readonly blockedPerson: string;
  /** Where the two areas meet: scopes, paths (up to a cap, the rest counted) and contracts. */
  readonly overlap: {
    readonly scopes: readonly string[];
    readonly paths: readonly string[];
    readonly contracts: readonly string[];
    readonly omittedPaths: number;
  };
  /** Penguin let the start open and the person is told; false while it waits for their approval. */
  readonly told: boolean;
  readonly read: boolean;
  /** When the request was raised, as an ISO 8601 time. */
  readonly raisedAt: string;
}

export interface OverlapRequests {
  readonly requests: readonly OverlapRequest[];
}

/** A feature id as the ProjectAgent stores it (feature-store.ts). */
export const FEATURE_ID_MAX_LENGTH = 63;
const FEATURE_ID_SCHEMA: JsonSchema = { type: "string", pattern: `^${SEGMENT_PATTERN}$`, maxLength: FEATURE_ID_MAX_LENGTH };

/** The covering key of an owner's-scope lock: `owner:<person>`. Feature ids hold no ":". */
export const OWNER_LOCK_PATTERN = `^owner:${PERSON_ID_PATTERN.slice(1)}`;
const OWNER_LOCK = new RegExp(OWNER_LOCK_PATTERN, "u");

export function ownerLockId(personId: string): string {
  return `owner:${personId}`;
}

/** True for an owner's-scope lock's covering key, `owner:<person>`. */
export function isOwnerLockId(value: unknown): value is string {
  return typeof value === "string" && value.length <= PERSON_ID_MAX_LENGTH + 6 && OWNER_LOCK.test(value);
}
const STRINGS: JsonSchema = { type: "array", items: { type: "string" } };

/** JSON Schema (draft 2020-12) for the GET /api/overlaps answer. */
export const OVERLAP_REQUESTS_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin overlapping starts",
  type: "object",
  additionalProperties: false,
  required: ["requests"],
  properties: {
    requests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["feature", "blockedFeature", "blockedPerson", "overlap", "told", "read", "raisedAt"],
        properties: {
          feature: { anyOf: [FEATURE_ID_SCHEMA, { type: "string", pattern: OWNER_LOCK_PATTERN, maxLength: PERSON_ID_MAX_LENGTH + 6 }] },
          blockedFeature: FEATURE_ID_SCHEMA,
          blockedPerson: { type: "string", pattern: PERSON_ID_PATTERN, maxLength: PERSON_ID_MAX_LENGTH },
          overlap: {
            type: "object",
            additionalProperties: false,
            required: ["scopes", "paths", "contracts", "omittedPaths"],
            properties: {
              scopes: STRINGS,
              paths: STRINGS,
              contracts: STRINGS,
              omittedPaths: { type: "integer", minimum: 0 },
            },
          },
          told: { type: "boolean" },
          read: { type: "boolean" },
          raisedAt: { type: "string" },
        },
      },
    },
  },
};

/** Where an answer breaks OVERLAP_REQUESTS_SCHEMA; empty when it conforms. */
export function checkOverlapRequests(value: unknown): SchemaError[] {
  return checkSchema(OVERLAP_REQUESTS_SCHEMA, value);
}
