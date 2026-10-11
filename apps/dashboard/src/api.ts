// The dashboard API client. Every call sends the session cookie; a 401 means the session ended.

import type { IssuePage } from "@penguin/protocol";

export interface Session {
  readonly owner: string;
  readonly login: string;
}

export interface InboxItem {
  readonly issueId: string;
  readonly reason: string;
  readonly read: boolean;
  readonly raisedAt: string;
}

export class SignedOut extends Error {
  constructor() {
    super("signed out");
  }
}

class NotFound extends Error {
  constructor() {
    super("not found");
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!response.ok) {
    // An unread body keeps the request open in the browser; the error body is short JSON.
    await response.arrayBuffer();
    if (response.status === 401) throw new SignedOut();
    throw response.status === 404 ? new NotFound() : new Error(`${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** The signed-in person, or undefined when nobody is signed in. */
export async function fetchSession(): Promise<Session | undefined> {
  try {
    return await getJson<Session>("/api/session");
  } catch (error) {
    if (error instanceof SignedOut) return undefined;
    throw error;
  }
}

export async function fetchInbox(): Promise<InboxItem[]> {
  return (await getJson<{ items: InboxItem[] }>("/api/inbox")).items;
}

/** The issue page, or undefined when no issue has this number or temporary ID. */
export async function fetchIssue(issueId: string): Promise<IssuePage | undefined> {
  try {
    return await getJson<IssuePage>(`/api/issues/${encodeURIComponent(issueId)}`);
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

export type WriteOutcome =
  | { readonly status: "applied"; readonly opId: string; readonly issueId: string; readonly version: number }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

/** Submits one operation as the signed-in person; Penguin sets the author from the session. */
export async function submitOperation(operation: {
  readonly issue: number | string;
  readonly type: string;
  readonly base_version: number;
  readonly payload: Record<string, unknown>;
}): Promise<WriteOutcome> {
  const response = await fetch("/api/operations", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(operation),
  });
  // 201 is applied and 422 rejected; both carry the outcome.
  if (response.status !== 201 && response.status !== 422) {
    await response.arrayBuffer();
    throw response.status === 401 ? new SignedOut() : new Error(`/api/operations answered ${response.status}`);
  }
  return (await response.json()) as WriteOutcome;
}
