// What GET /api/inbox returns to the dashboard: the signed-in person's inbox items, newest first, each
// with its issue's title and state. The ProjectAgent builds it (services/project-agent/src/inbox-page.ts)
// from its InboxItem rows; the inbox page groups it (apps/dashboard/src/inbox-view.ts). The Worker
// checks it against INBOX_SCHEMA before answering, so a malformed field never reaches the page.

import type { IssuePageState } from "./issue-page.ts";
import { IDENTITY_HANDLE_SCHEMA } from "./operation-schema.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

/**
 * Why an item is in the inbox: an assignment to the person or an identity they answer for, a mention,
 * the issue closing, a request to start a session of an identity for the issue, a request to
 * review a fix whose combined tests pass, or a thread on the issue that needs the person.
 */
export type InboxReason = "assigned" | "mentioned" | "closed" | "start_session" | "review_requested" | "thread";

export interface InboxEntry {
  readonly issueId: string;
  readonly reason: InboxReason;
  readonly read: boolean;
  /** When the item was created or last marked unread by a new event, as an ISO 8601 time. */
  readonly raisedAt: string;
  readonly title: string;
  readonly state: IssuePageState;
  /**
   * The handles of the identities assigned to the issue, in assignment order; empty when no identity
   * is. A person assignee has no handle and is not listed.
   */
  readonly assigneeHandles: readonly string[];
}

export interface Inbox {
  readonly items: readonly InboxEntry[];
}

const REASONS: readonly InboxReason[] = ["assigned", "mentioned", "closed", "start_session", "review_requested", "thread"];
const STATES: readonly IssuePageState[] = ["open", "detected", "fixing", "verifying", "in_review", "closed"];

/** JSON Schema (draft 2020-12) for the GET /api/inbox answer. */
export const INBOX_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin inbox",
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issueId", "reason", "read", "raisedAt", "title", "state", "assigneeHandles"],
        properties: {
          issueId: { type: "string" },
          reason: { type: "string", enum: [...REASONS] },
          read: { type: "boolean" },
          raisedAt: { type: "string" },
          title: { type: "string" },
          state: { type: "string", enum: [...STATES] },
          assigneeHandles: { type: "array", items: IDENTITY_HANDLE_SCHEMA, uniqueItems: true },
        },
      },
    },
  },
};

/** Where an inbox breaks INBOX_SCHEMA; empty when it conforms. */
export function checkInbox(value: unknown): SchemaError[] {
  return checkSchema(INBOX_SCHEMA, value);
}
