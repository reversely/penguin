// What the inbox page derives from GET /api/inbox: the person's items sorted into the five lists of
// PRD section 8 (needs your review, assigned to your identities, mentions, threads that need you,
// recently closed) and the unread count. Pure, so the rules are tested without a browser
// (test/inbox-view.test.ts).
//
// The headings are plain nouns. "Assignments" holds assignments to the person or to an identity they
// answer for. It also holds the session router's requests to start a session of such an identity for
// the issue. "Review requests" holds the requests to review a fix whose combined tests pass. "Threads"
// holds the issues with a thread that needs the person, such as one a request for changes opened.

import type { InboxEntry, InboxReason } from "@penguin/protocol";

export type InboxGroupId = "review" | "assigned" | "mentioned" | "threads" | "closed";

export const INBOX_GROUPS: readonly { readonly id: InboxGroupId; readonly label: string }[] = [
  { id: "review", label: "Review requests" },
  { id: "assigned", label: "Assignments" },
  { id: "mentioned", label: "Mentions" },
  { id: "threads", label: "Threads" },
  { id: "closed", label: "Closed issues" },
];

const GROUP_OF_REASON: Readonly<Record<InboxReason, InboxGroupId>> = {
  assigned: "assigned",
  start_session: "assigned",
  mentioned: "mentioned",
  closed: "closed",
  review_requested: "review",
  thread: "threads",
};

/** The tag an item carries beside its issue when its list alone does not say why it is there. */
export const REASON_TAG: Readonly<Partial<Record<InboxReason, string>>> = {
  start_session: "Start a session",
};

/** Each list's items in the order the inbox gives them, newest first. An unknown reason is left out. */
export function groupInbox(items: readonly InboxEntry[]): Record<InboxGroupId, InboxEntry[]> {
  const groups: Record<InboxGroupId, InboxEntry[]> = { review: [], assigned: [], mentioned: [], threads: [], closed: [] };
  for (const item of items) {
    const group = Object.hasOwn(GROUP_OF_REASON, item.reason) ? GROUP_OF_REASON[item.reason] : undefined;
    if (group !== undefined) groups[group].push(item);
  }
  return groups;
}

/** How many closed issues the inbox lists until "Show all" lists every one. */
export const CLOSED_WINDOW = 10;

/** The first `size` items of a newest-first list, or all of them. */
export function newest<T>(items: readonly T[], size: number, showAll: boolean): readonly T[] {
  return showAll ? items : items.slice(0, size);
}

export function unreadCount(items: readonly InboxEntry[]): number {
  return items.filter((item) => !item.read).length;
}

/** An item is one issue and one reason. */
export function itemKey(item: Pick<InboxEntry, "issueId" | "reason">): string {
  return `${item.reason}:${item.issueId}`;
}

/** The items after one is marked read. */
export function markedRead(items: readonly InboxEntry[], key: string): InboxEntry[] {
  return items.map((item) => (itemKey(item) === key ? { ...item, read: true } : item));
}
