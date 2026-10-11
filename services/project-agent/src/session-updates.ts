// Writes from an agent session (PRD sections 5 and 8): `post_update` applies an issue operation at
// once and queues it for the Git log. The author is always the session's identity, read from the
// session the caller owns; the update carries no author of its own. The identity's charter is then
// checked by the validator like any identity-authored operation.
//
// A send_upstream (upstream.ts) skips the check that the issue is routed to the session: the reducer
// judges whether the identity is assigned, and the issue records the rejection. Once it applies,
// Penguin reassigns the issue.

import type { ReduceRejectReason, RejectReason } from "@penguin/issues";
import type { Author } from "@penguin/protocol";

import { CLOSE_RECORDED_REJECTIONS } from "./huddle-close.ts";
import type { SubmitOutcome } from "./issue-index.ts";
import type { SessionRejection, SessionStore } from "./session-store.ts";
import { UPSTREAM_RECORDED_REJECTIONS, type Reassignment } from "./upstream.ts";

/** The operation types a session posts through `post_update`. */
export const SESSION_UPDATE_TYPES = [
  "comment",
  "reply_thread",
  "link_commit",
  "change_state",
  "add_label",
  "remove_label",
  "send_upstream",
] as const;

export type SessionUpdateType = (typeof SESSION_UPDATE_TYPES)[number];

export interface SessionUpdate {
  /** The issue's number, or the temporary ID of an issue created offline, which resolves to it. */
  readonly issue: number | string;
  readonly type: SessionUpdateType;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The issue version the session read. When absent, the issue's current version is used. */
  readonly baseVersion?: number;
}

export type SessionUpdateOutcome =
  | SubmitOutcome
  | (Extract<SubmitOutcome, { status: "applied" }> & { readonly reassignment: Reassignment })
  | SessionRejection;

export interface SessionUpdateDeps {
  readonly sessions: Pick<SessionStore, "heartbeat" | "routes">;
  /** The issue's current version, or undefined when no such issue exists. */
  readonly issueVersion: (issueId: string) => number | undefined;
  /**
   * Signs, applies and queues the operation as `author` (ProjectAgent.submit with source "mcp"). A
   * rejection whose reason is in `recordRejections` is recorded on the issue.
   */
  readonly submit: (
    operation: Record<string, unknown>,
    author: Author,
    recordRejections?: readonly (RejectReason | ReduceRejectReason)[],
  ) => Promise<SubmitOutcome>;
  /** Penguin's reassignment of an issue `sender` sent upstream (upstream.ts reassignUpstream). */
  readonly reassignUpstream: (issueId: string, sender: string) => Promise<Reassignment>;
}

/**
 * Posts one update from session `sessionId`, which `caller` must own and which must be running. The
 * call counts as the session's heartbeat. The issue must be assigned to the session's identity; for
 * a send_upstream the reducer checks that, and the rejection is recorded.
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
  const upstream = update.type === "send_upstream";
  if (!upstream && !deps.sessions.routes(issueId).some((route) => route.handle === handle)) {
    return { status: "rejected", reason: "not_found", message: `issue ${issueId} is not assigned to ${handle}` };
  }
  const operation = {
    issue: update.issue,
    type: update.type,
    base_version: update.baseVersion ?? deps.issueVersion(issueId) ?? 0,
    payload: update.payload,
  };
  // A refused close of a Huddle issue is recorded, so the timeline says what the Huddle waits on.
  if (!upstream) return deps.submit(operation, { identity: handle }, update.type === "change_state" ? CLOSE_RECORDED_REJECTIONS : undefined);
  const outcome = await deps.submit(operation, { identity: handle }, UPSTREAM_RECORDED_REJECTIONS);
  if (outcome.status !== "applied") return outcome;
  return { ...outcome, reassignment: await deps.reassignUpstream(outcome.issueId, handle) };
}
