// What GET /api/overlaps returns to the dashboard: the overlapping starts that wait for the signed-in
// person's approval (PRD 0.4 section 4.1 step 3). Each names the person's own running feature, the
// feature whose start waits and where the two areas meet. The ProjectAgent builds it from the
// person's overlap inbox items and the stored locks (services/project-agent/src/overlap-lock.ts); the
// Worker checks it against OVERLAP_REQUESTS_SCHEMA before answering.

import { PERSON_ID_MAX_LENGTH, PERSON_ID_PATTERN, SEGMENT_PATTERN } from "./operation-schema.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

export interface OverlapRequest {
  /** The person's own running feature, which covers the area. */
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
        required: ["feature", "blockedFeature", "blockedPerson", "overlap", "read", "raisedAt"],
        properties: {
          feature: FEATURE_ID_SCHEMA,
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
