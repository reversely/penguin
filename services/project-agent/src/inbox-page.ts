// Builds the dashboard's inbox (PRD section 8) for one person: their inbox items, newest first, each
// with its issue's title and state, so the page needs no read per item. The result is plain JSON for
// Durable Object RPC.

import type { IssueRecord } from "@penguin/issues";
import type { Inbox } from "@penguin/protocol";

import type { InboxItem } from "./inbox-store.ts";

export interface InboxPageSources {
  /** The person's items, newest first (InboxStore.items). */
  items(person: string): readonly InboxItem[];
  issue(id: string): IssueRecord | undefined;
}

/** The person's inbox. An item whose issue the index no longer holds is left out. */
export function buildInbox(sources: InboxPageSources, person: string): Inbox {
  return {
    items: sources.items(person).flatMap(({ issueId, reason, read, raisedAt }) => {
      const issue = sources.issue(issueId);
      return issue === undefined ? [] : [{ issueId, reason, read, raisedAt, title: issue.title, state: issue.state }];
    }),
  };
}
