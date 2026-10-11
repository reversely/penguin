// Builds the dashboard's board (PRD section 8) from the issue index, the identities and the session
// router: every issue as the issue page shows it, without the timeline, and every owner with their
// identities and those identities' running sessions. The dashboard sorts issues into columns and
// swimlanes (apps/dashboard/src/board-view.ts). The result is plain JSON for Durable Object RPC.

import type { IssueRecord } from "@penguin/issues";
import type { Board, BoardIdentity, BoardIssue, BoardOwner } from "@penguin/protocol";

import type { Identity } from "./identity-store.ts";
import { issueView, type IssuePageSources } from "./issue-page.ts";
import { responsibleOwners, type Session } from "./session-store.ts";

export interface BoardSources extends Omit<IssuePageSources, "read"> {
  /** Every issue's number. */
  ids(): readonly string[];
  identities(): readonly Identity[];
  /** Every running session. */
  running(): readonly Session[];
  /** The owner who assigned an identity to an issue (IssueIndex.assigningOwner). */
  assigningOwner(issueId: string, handle: string): string | undefined;
}

export function buildBoard(sources: BoardSources): Board {
  const identities = sources.identities();
  const byHandle = new Map(identities.map((identity) => [identity.handle, identity]));
  const issues = sources.ids().flatMap((id) => {
    const issue = sources.issue(id);
    return issue === undefined ? [] : [boardIssue(sources, issue, byHandle)];
  });
  return { owners: owners(identities, sources.running(), issues), issues };
}

function boardIssue(sources: BoardSources, issue: IssueRecord, byHandle: ReadonlyMap<string, Identity>): BoardIssue {
  const laneOwners: Record<string, readonly string[]> = {};
  for (const { assigneeKind, assigneeId } of issue.assignments.values()) {
    if (assigneeKind === "person") {
      laneOwners[assigneeId] = [assigneeId];
      continue;
    }
    const identity = byHandle.get(assigneeId);
    laneOwners[assigneeId] =
      identity === undefined ? [] : responsibleOwners(identity, () => sources.assigningOwner(issue.id, assigneeId));
  }
  // The board shows no commits' linkers, so it skips reading each issue's timeline for them.
  return { ...issueView(sources, issue, () => null), laneOwners };
}

/**
 * Each owner with the identities they own or serve, in owner order. An owner who holds no identity
 * but has an issue in their swimlane is listed too, with no identities.
 */
function owners(identities: readonly Identity[], running: readonly Session[], issues: readonly BoardIssue[]): BoardOwner[] {
  const sessions = new Map<string, Session[]>();
  for (const session of running) sessions.set(session.identityId, [...(sessions.get(session.identityId) ?? []), session]);
  const lanes = new Map<string, BoardIdentity[]>();
  const lane = (owner: string): BoardIdentity[] => {
    if (!lanes.has(owner)) lanes.set(owner, []);
    return lanes.get(owner) as BoardIdentity[];
  };
  for (const identity of identities) {
    const entry: BoardIdentity = {
      handle: identity.handle,
      name: identity.name,
      avatar: identity.avatar === null ? null : `data:${identity.avatar.mediaType};base64,${base64(identity.avatar.data)}`,
      team: identity.ownerId === null,
      sessions: (sessions.get(identity.id) ?? []).map((session) => ({
        id: session.id,
        vendor: session.vendor,
        branch: session.branch,
        lastSeen: session.lastSeen,
      })),
    };
    for (const owner of identity.ownerId === null ? identity.teamOwners : [identity.ownerId]) lane(owner).push(entry);
  }
  for (const issue of issues) for (const owners of Object.values(issue.laneOwners)) owners.forEach(lane);
  return [...lanes.keys()].sort().map((id) => ({ id, identities: lanes.get(id) as BoardIdentity[] }));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
