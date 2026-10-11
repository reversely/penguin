// What GET /api/inbox returns to the dashboard: the signed-in person's inbox items, newest first, each
// with its issue's title and state. The ProjectAgent builds it (services/project-agent/src/inbox-page.ts)
// from its InboxItem rows; the inbox page groups it (apps/dashboard/src/inbox-view.ts).

import type { IssuePageState } from "./issue-page.ts";

/**
 * Why an item is in the inbox: an assignment to the person or an identity they answer for, a mention,
 * the issue closing, or a request to start a session of an identity for the issue.
 */
export type InboxReason = "assigned" | "mentioned" | "closed" | "start_session";

export interface InboxEntry {
  readonly issueId: string;
  readonly reason: InboxReason;
  readonly read: boolean;
  /** When the item was created or last marked unread by a new event, as an ISO 8601 time. */
  readonly raisedAt: string;
  readonly title: string;
  readonly state: IssuePageState;
}

export interface Inbox {
  readonly items: readonly InboxEntry[];
}
