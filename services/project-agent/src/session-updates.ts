// Writes from an agent session (PRD sections 5 and 8): `post_update` applies an issue operation at
// once and queues it for the Git log. The author is always the session's identity, read from the
// session the caller owns; the update carries no author of its own. The identity's charter is then
// checked by the validator like any identity-authored operation.

import type { Author } from "@penguin/protocol";

import type { SubmitOutcome } from "./issue-index.ts";
import type { SessionRejection, SessionStore } from "./session-store.ts";

/** The operation types a session posts through `post_update`. */
export const SESSION_UPDATE_TYPES = [
  "comment",
  "reply_thread",
  "link_commit",
  "change_state",
  "add_label",
  "remove_label",
] as const;

export type SessionUpdateType = (typeof SESSION_UPDATE_TYPES)[number];

export interface SessionUpdate {
  /** The issue's display number, or the op_id of its create operation. */
  readonly issue: number | string;
  readonly type: SessionUpdateType;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The issue version the session read. When absent, the issue's current version is used. */
  readonly baseVersion?: number;
}

export type SessionUpdateOutcome = SubmitOutcome | SessionRejection;

export interface SessionUpdateDeps {
  readonly sessions: Pick<SessionStore, "heartbeat" | "routes">;
  /** The issue's current version, or undefined when no such issue exists. */
  readonly issueVersion: (issueId: string) => number | undefined;
  /** Signs, applies and queues the operation as `author` (ProjectAgent.submit with source "mcp"). */
  readonly submit: (operation: Record<string, unknown>, author: Author) => Promise<SubmitOutcome>;
}

/**
 * Posts one update from session `sessionId`, which `caller` must own and which must be running. The
 * call counts as the session's heartbeat. The issue must be assigned to the session's identity.
 */
export async function postSessionUpdate(
  deps: SessionUpdateDeps,
  caller: string,
  sessionId: string,
  update: SessionUpdate,
): Promise<SessionUpdateOutcome> {
  if (!SESSION_UPDATE_TYPES.includes(update.type)) {
    return { status: "rejected", reason: "invalid", message: `a session cannot post a ${String(update.type)} update` };
  }
  const live = deps.sessions.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const handle = live.session.handle;
  const issueId = String(update.issue);
  if (!deps.sessions.routes(issueId).some((route) => route.handle === handle)) {
    return { status: "rejected", reason: "not_found", message: `issue ${issueId} is not assigned to ${handle}` };
  }
  const operation = {
    issue: update.issue,
    type: update.type,
    base_version: update.baseVersion ?? deps.issueVersion(issueId) ?? 0,
    payload: update.payload,
  };
  return deps.submit(operation, { identity: handle });
}
