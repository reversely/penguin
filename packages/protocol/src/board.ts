// What GET /api/board returns to the dashboard: every issue without its timeline, and each owner with
// the identities they own or serve and those identities' running sessions. The ProjectAgent builds it
// (services/project-agent/src/board.ts); the board page sorts it into columns and swimlanes
// (apps/dashboard/src/board-view.ts).

import type { IssuePage } from "./issue-page.ts";

/** A running session of an identity. */
export interface BoardSession {
  readonly id: string;
  readonly vendor: string;
  readonly branch: string;
  /** When the session last registered or sent a heartbeat, as an ISO 8601 time. */
  readonly lastSeen: string;
}

export interface BoardIdentity {
  readonly handle: string;
  readonly name: string;
  /** The avatar as a `data:` URL of a PNG, JPEG, GIF or WebP image, or null. */
  readonly avatar: string | null;
  readonly team: boolean;
  readonly sessions: readonly BoardSession[];
}

export interface BoardOwner {
  readonly id: string;
  /** The owner's identities, and each team identity the owner serves. */
  readonly identities: readonly BoardIdentity[];
}

/** One issue as the issue page shows it, without the timeline. */
export interface BoardIssue extends Omit<IssuePage, "timeline"> {
  /**
   * For each assignee id (a person id or an identity handle), the owners whose swimlane holds the
   * card: the person; a personal identity's owner; the owner who assigned a team identity, or every
   * team owner when Penguin assigned it.
   */
  readonly laneOwners: Readonly<Record<string, readonly string[]>>;
}

export interface Board {
  readonly owners: readonly BoardOwner[];
  readonly issues: readonly BoardIssue[];
}
