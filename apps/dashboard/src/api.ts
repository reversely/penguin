// The dashboard API client. Every call sends the session cookie; a 401 means the session ended.

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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!response.ok) {
    // An unread body keeps the request open in the browser; the error body is short JSON.
    await response.arrayBuffer();
    throw response.status === 401 ? new SignedOut() : new Error(`${path} answered ${response.status}`);
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
