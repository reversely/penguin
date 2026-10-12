// What the issue pages' sidebar list derives from GET /api/inbox: the person's items sorted into the
// five lists of PRD section 8 (needs your review, assigned to your identities, mentions, threads that
// need you, recently closed). With GET /api/board it also derives what an item waits on
// the person for and whether its assignee runs a session (identity plan section 5, "Sidebar row").
// Pure, so the rules are tested without a browser (test/inbox-view.test.ts).
//
// The headings are plain nouns. "Assignments" holds assignments to the person or to an identity they
// answer for. It also holds the session router's requests to start a session of such an identity for
// the issue. "Review requests" holds the requests to review a fix whose combined tests pass. "Threads"
// holds the issues with a thread that needs the person, such as one a request for changes opened.

import type { Board, BoardIdentity, BoardIssue, InboxEntry, InboxReason } from "@penguin/protocol";

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

/** What an item waits on the person for. */
export type Waiting = "review" | "reply" | "start_session" | "acceptance";

/** The preview a waiting item shows in place of its issue's state. */
export const WAITING_PREVIEW: Readonly<Record<Waiting, string>> = {
  review: "Review",
  reply: "Reply",
  start_session: "Session to start",
  acceptance: "Acceptance",
};

/**
 * What the item waits on `viewer` for, or null. A review request and a session request say so by
 * their reason. Any other item on an open issue waits for the viewer's reply while an open thread
 * needs them. An assignment waits for their acceptance while an identity in their swimlane awaits
 * it. `issue` is the item's issue on the board, unknown until the board is read.
 */
export function waitingFor(item: InboxEntry, issue: BoardIssue | undefined, viewer: string): Waiting | null {
  if (item.reason === "review_requested") return "review";
  if (item.reason === "start_session") return "start_session";
  if (item.reason === "closed" || issue === undefined || issue.issue.state === "closed") return null;
  const { threads, assignees } = issue.issue;
  if (threads.some((thread) => thread.status === "open" && thread.needsPersonIds.includes(viewer))) return "reply";
  const accepts = (handle: string) => issue.laneOwners[handle]?.includes(viewer) ?? false;
  const awaiting = assignees.some((assignee) => assignee.kind === "identity" && assignee.waitingFor === "acceptance" && accepts(assignee.id));
  return item.reason === "assigned" && awaiting ? "acceptance" : null;
}

/** The board's issues by id and its identities by handle, for the rows' lookups. */
export interface BoardFacts {
  readonly issues: ReadonlyMap<string, BoardIssue>;
  readonly identities: ReadonlyMap<string, BoardIdentity>;
}

export function boardFacts(board: Board): BoardFacts {
  const issues = new Map(board.issues.map((issue) => [issue.issue.id, issue] as const));
  // A team identity is listed under each owner it serves; every copy carries the same sessions.
  const identities = new Map(board.owners.flatMap((owner) => owner.identities.map((identity) => [identity.handle, identity] as const)));
  return { issues, identities };
}

/** Whether the identity runs a session now; the board lists running sessions only. */
export function isOnline(identity: BoardIdentity | undefined): boolean {
  return identity !== undefined && identity.sessions.length > 0;
}

/**
 * When an item was raised, as short as a row allows: the time today, the weekday within the past
 * week, else the date, with the year when it is not this year. Empty for a time that does not parse.
 */
export function raisedLabel(iso: string, now: Date, locale?: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const raised = new Date(time);
  // Local midnights, so a daylight-saving change never moves a day boundary.
  const midnight = (daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  if (time >= midnight(0)) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(raised);
  if (time >= midnight(6)) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(raised);
  const year = raised.getFullYear() === now.getFullYear() ? undefined : "numeric";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year }).format(raised);
}

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

/** An item is one issue and one reason. */
export function itemKey(item: Pick<InboxEntry, "issueId" | "reason">): string {
  return `${item.reason}:${item.issueId}`;
}

/** The items after one is marked read. */
export function markedRead(items: readonly InboxEntry[], key: string): InboxEntry[] {
  return items.map((item) => (itemKey(item) === key ? { ...item, read: true } : item));
}
