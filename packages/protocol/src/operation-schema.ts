// JSON Schema (draft 2020-12) for one issue operation file, `issues/<id>/ops/<author>-<writer>-<seq>.json`.
// The schema is plain JSON data so any standard validator can load it; `checkSchema` applies it here.

import type { JsonSchema } from "./schema-check.ts";

export const OPERATION_SCHEMA_VERSION = 1;

/** Largest operation file, in bytes, that a reader accepts. Checked before the file is parsed. */
export const MAX_OPERATION_FILE_BYTES = 65_536;

/**
 * One path segment: lowercase letters and digits, joined by single dots or hyphens. It cannot be
 * empty, start or end with a separator, or contain "..", so it can never name a parent folder.
 */
export const SEGMENT_PATTERN = "[a-z0-9]+(?:[.-][a-z0-9]+)*";

/**
 * An allowlisted command ID: segments of lowercase letters and digits joined by single dots, hyphens
 * or colons, such as `test:analytics` for a scope's test command.
 */
export const COMMAND_ID_PATTERN = "[a-z0-9]+(?:[.:-][a-z0-9]+)*";

/** A check result's fingerprint: a SHA-256 in lowercase hexadecimal. */
export const FINGERPRINT_PATTERN = "[0-9a-f]{64}";

/** A person ID or one half of an identity handle: lowercase letters and digits, joined by single hyphens. */
const NAME_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";

/** A whole person ID. "penguin" also matches; it is reserved (see PENGUIN_AUTHOR_SEGMENT). */
export const PERSON_ID_PATTERN = `^${NAME_PATTERN}$`;
export const PERSON_ID_MAX_LENGTH = 39;

/** A whole identity handle, "@<owner>/<name>". */
export const IDENTITY_HANDLE_PATTERN = `^@${NAME_PATTERN}/${NAME_PATTERN}$`;
export const IDENTITY_HANDLE_MAX_LENGTH = 80;

/** One identity handle, wherever the protocol carries one. */
export const IDENTITY_HANDLE_SCHEMA: JsonSchema = {
  type: "string",
  maxLength: IDENTITY_HANDLE_MAX_LENGTH,
  pattern: IDENTITY_HANDLE_PATTERN,
  description: "@<owner>/<name>. Its author segment is <owner>.<name>.",
};

/**
 * A writer's sequence number for one author: decimal, at least four digits, zero-padded to exactly
 * four when it is below 1000, and at least 1. One number has exactly one spelling, so "jun-web-7" and
 * "jun-web-00007" are not aliases of "jun-web-0007".
 */
export const SEQ_PATTERN = "(?:(?!0000)[0-9]{4}|[1-9][0-9]{4,8})";

/**
 * The writer that numbered an operation: `web` for the Worker (the dashboard, MCP and Penguin itself),
 * or a bridge's tag. Lowercase letters and digits with no separator, so an op_id splits unambiguously
 * from the right into author segment, writer and sequence number.
 */
export const WRITER_TAG_PATTERN = "[a-z0-9]{1,16}";

/** The Worker's writer tag. A bridge tag is hexadecimal, so it is never this. */
export const WEB_WRITER_TAG = "web";

/**
 * `<author segment>-<writer>-<seq>`. Each writer counts its own sequence per author, so an offline
 * bridge and the Worker never assign the same op_id.
 */
export const OP_ID_PATTERN = `^${SEGMENT_PATTERN}-${WRITER_TAG_PATTERN}-${SEQ_PATTERN}$`;

/** The service author's segment. No person may take this ID. */
export const PENGUIN_AUTHOR_SEGMENT = "penguin";

export const OPERATION_TYPES = [
  "create",
  "edit",
  "comment",
  "edit_comment",
  "add_label",
  "remove_label",
  "assign",
  "unassign",
  "mention",
  "link_commit",
  "attach_check",
  "open_sub_issue",
  "review",
  "open_thread",
  "reply_thread",
  "resolve_thread",
  "change_state",
  "send_upstream",
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

/** How a close ends an issue's work (PRD section 6): approved, or cancelled by the owner who started it. */
export const CLOSE_RESOLUTIONS = ["approved", "cancelled"] as const;

export type CloseResolution = (typeof CLOSE_RESOLUTIONS)[number];

const TEXT_MAX = 32_768;

/** Most checks one `link_commit` may mark superseded; it keeps the operation under the file size cap. */
export const MAX_SUPERSEDED_CHECKS = 256;

const title = { type: "string", minLength: 1, maxLength: 256 };
const body = { type: "string", maxLength: TEXT_MAX };
const nonEmptyBody = { type: "string", minLength: 1, maxLength: TEXT_MAX };
const reason = { type: "string", minLength: 1, maxLength: 2_000 };
const opRef = { $ref: "#/$defs/op_id" };

function payload(properties: Record<string, unknown>, required: string[], extra: JsonSchema = {}): JsonSchema {
  return { type: "object", additionalProperties: false, properties, required, ...extra };
}

export const PAYLOAD_SCHEMAS: Readonly<Record<OperationType, JsonSchema>> = {
  create: payload({ title, body }, ["title"]),
  edit: payload({ title, body }, [], {
    description: "Replaces the title, the body or both.",
    minProperties: 1,
  }),
  comment: payload({ body: nonEmptyBody }, ["body"], {
    description: "The comment is identified later by this operation's op_id.",
  }),
  edit_comment: payload({ comment: opRef, body: nonEmptyBody }, ["comment", "body"], {
    description: "`comment` is the op_id of the comment operation being edited.",
  }),
  add_label: payload({ label: { $ref: "#/$defs/label" } }, ["label"]),
  remove_label: payload({ label: { $ref: "#/$defs/label" } }, ["label"]),
  assign: payload({ assignee: { $ref: "#/$defs/party" } }, ["assignee"]),
  unassign: payload({ assignee: { $ref: "#/$defs/party" } }, ["assignee"]),
  mention: payload({ mentioned: { $ref: "#/$defs/party" }, comment: opRef }, ["mentioned"], {
    description: "`comment`, when present, is the op_id of the comment that carries the mention.",
  }),
  link_commit: payload(
    {
      commit: { $ref: "#/$defs/commit" },
      kind: { type: "string", enum: ["trigger", "fix", "related", "approved"] },
      supersedes: { type: "array", items: opRef, minItems: 1, maxItems: MAX_SUPERSEDED_CHECKS, uniqueItems: true },
    },
    ["commit"],
    {
      description:
        "`supersedes` lists the op_ids of checks on this issue that the linked commit makes out of date: a " +
        "newer checkpoint changes the code those results ran against, so they no longer count. Only Penguin " +
        "writes it. Kind `approved` records the Huddle repo's `approved` branch as close-out evidence; only " +
        "Penguin links it.",
    },
  ),
  attach_check: payload(
    {
      command_id: { type: "string", pattern: `^${COMMAND_ID_PATTERN}$`, maxLength: 64 },
      commit: { $ref: "#/$defs/commit" },
      test: { type: "string", minLength: 1, maxLength: 256 },
      result: { type: "string", enum: ["pass", "fail", "error"] },
      log_ref: { type: "string", minLength: 1, maxLength: 512 },
      fingerprint: { type: "string", pattern: `^${FINGERPRINT_PATTERN}$` },
    },
    ["command_id", "commit", "result"],
    {
      description:
        "`command_id` is an allowlisted command ID from the repository config, such as `test:analytics`. " +
        "`fingerprint` is the SHA-256 of the tested commit, its lockfiles and the command ID, so the " +
        "result applies only to the inputs it ran against.",
    },
  ),
  open_sub_issue: payload({ sub_issue: { $ref: "#/$defs/issue" } }, ["sub_issue"], {
    description: "Records an issue, created by its own create operation, as a sub-issue of this one.",
  }),
  review: payload(
    {
      verdict: { type: "string", enum: ["approve", "request_changes"] },
      commit: { $ref: "#/$defs/commit" },
      reason,
    },
    ["verdict", "commit"],
    {
      description: "A request for changes must give a reason.",
      allOf: [{ if: { properties: { verdict: { const: "request_changes" } } }, then: { required: ["reason"] } }],
    },
  ),
  open_thread: payload(
    {
      body: nonEmptyBody,
      anchor: { type: "string", minLength: 1, maxLength: 512 },
      needs: { type: "array", items: { $ref: "#/$defs/person" }, uniqueItems: true, maxItems: 32 },
    },
    ["body"],
    {
      description:
        "The thread is identified later by this operation's op_id. `needs` lists the people the thread waits on.",
    },
  ),
  reply_thread: payload({ thread: opRef, body: nonEmptyBody }, ["thread", "body"]),
  resolve_thread: payload({ thread: opRef, reason }, ["thread"]),
  change_state: payload(
    {
      state: { type: "string", enum: ["open", "detected", "fixing", "verifying", "in_review", "closed"] },
      reason,
      resolution: { type: "string", enum: CLOSE_RESOLUTIONS },
    },
    ["state", "reason"],
    {
      description:
        "`resolution` says how a close ends the work: `approved` once Penguin records the approved branch, or " +
        "`cancelled` by the owner who started it. A Huddle issue's close without one is judged as approved.",
      allOf: [{ if: { required: ["resolution"] }, then: { properties: { state: { const: "closed" } } } }],
    },
  ),
  send_upstream: payload({ reason }, ["reason"], {
    description:
      "An identity assigned to a Huddle's fix sub-issue says the fix lies outside its charter, in the scope " +
      "the trigger changed. Penguin then reassigns the sub-issue to an identity of that scope's owner.",
  }),
};

export const OPERATION_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin issue operation",
  description:
    "One signed change to one issue, stored as issues/<issue>/ops/<op_id>.json in the project's issues repo. " +
    `A reader rejects a file larger than ${MAX_OPERATION_FILE_BYTES} bytes before parsing it. ` +
    "The op_id begins with the author's segment (see $defs/author), then the writer tag.",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "op_id", "issue", "type", "author", "base_version", "payload", "signature"],
  properties: {
    schema_version: { const: OPERATION_SCHEMA_VERSION },
    op_id: { $ref: "#/$defs/op_id" },
    issue: { $ref: "#/$defs/issue" },
    type: { type: "string", enum: [...OPERATION_TYPES] },
    author: { $ref: "#/$defs/author" },
    base_version: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
      description:
        "The issue version the author saw when writing this operation: the number of operations the " +
        "ProjectAgent has applied to the issue. Rejected operations do not advance it. A create carries 0.",
    },
    payload: { type: "object" },
    signature: {
      type: "string",
      pattern: "^[A-Za-z0-9_-]{86}$",
      description:
        "Ed25519 signature, base64url without padding, over the canonical JSON (RFC 8785 ordering) of " +
        "every other field of this object.",
    },
  },
  allOf: OPERATION_TYPES.map((type) => ({
    if: { properties: { type: { const: type } }, required: ["type"] },
    then: { properties: { payload: { $ref: `#/$defs/payload_${type}` } } },
  })),
  $defs: {
    op_id: {
      type: "string",
      maxLength: 128,
      pattern: OP_ID_PATTERN,
      description:
        "<author segment>-<writer>-<seq>. The writer is `web` for the Worker or the writing bridge's tag; " +
        "each writer numbers its own operations per author, so the op_id is unique across the project.",
    },
    issue: {
      description:
        "The issue's folder name: its number, or its temporary ID, the op_id of its create operation, for " +
        "an issue a bridge created without a number. Penguin assigns the next number when it applies such " +
        "a create, and the temporary ID then resolves to that number.",
      anyOf: [
        { type: "integer", minimum: 1, maximum: 2_147_483_647 },
        { type: "string", maxLength: 128, pattern: OP_ID_PATTERN },
      ],
    },
    person: {
      type: "string",
      maxLength: PERSON_ID_MAX_LENGTH,
      pattern: PERSON_ID_PATTERN,
      not: { const: PENGUIN_AUTHOR_SEGMENT },
    },
    identity: IDENTITY_HANDLE_SCHEMA,
    party: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["person"],
          properties: { person: { $ref: "#/$defs/person" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["identity"],
          properties: { identity: { $ref: "#/$defs/identity" } },
        },
      ],
    },
    author: {
      description: 'A person, an identity, or Penguin itself ({"penguin": true}, author segment "penguin").',
      oneOf: [
        { $ref: "#/$defs/party" },
        {
          type: "object",
          additionalProperties: false,
          required: ["penguin"],
          properties: { penguin: { const: true } },
        },
      ],
    },
    label: { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$" },
    commit: {
      type: "string",
      maxLength: 200,
      pattern: `^${SEGMENT_PATTERN}@[0-9a-f]{6,64}$`,
      description: "<artifacts repo>@<commit sha or unique prefix>, as in owner-priya@9b2f10.",
    },
    ...Object.fromEntries(OPERATION_TYPES.map((type) => [`payload_${type}`, PAYLOAD_SCHEMAS[type]])),
  },
};
