// Builds the dashboard's identities page (PRD section 8: "create, edit and duplicate identities; set
// each charter; see each identity's sessions and issue history") from the identity store, the session
// router, the issue index, the owner forks and the scope map. Each identity also carries the facts its
// agent card shows: its last reported checkpoint and its recent operations. The result is plain JSON
// for Durable Object RPC.

import type { IssueRecord } from "@penguin/issues";
import type { IdentitiesPage, IdentityCheckpoint, IdentityEntry, IdentityOperation, IdentityWriteOutcome } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { IDENTITY_LIMITS, type Avatar, type Identity, type IdentityOutcome } from "./identity-store.ts";
import type { OwnerFork } from "./owner-forks.ts";
import type { Session } from "./session-store.ts";

/** How many of an identity's sessions the page lists, most recent first. */
export const PAGE_SESSIONS_PER_IDENTITY = 10;

/** How many of an identity's applied operations its agent card lists, newest first. */
export const PAGE_OPERATIONS_PER_IDENTITY = 5;

export interface IdentitiesPageSources {
  identities(): readonly Identity[];
  /** Each identity's sessions by identity id (SessionStore.byIdentity). */
  sessions(): ReadonlyMap<string, readonly Session[]>;
  /** Each handle's issue ids, most recent first (IssueIndex.identityHistory). */
  history(): ReadonlyMap<string, readonly string[]>;
  issue(id: string): IssueRecord | undefined;
  /** Every owner's fork with its latest checkpoint (OwnerForkStore.list). */
  forks(): readonly OwnerFork[];
  /** The identity's newest applied operations (IssueIndex.authoredOperations). */
  operations(handle: string): readonly IdentityOperation[];
  scopeMap: ScopeMap;
}

export function buildIdentitiesPage(sources: IdentitiesPageSources): IdentitiesPage {
  const identities = sources.identities();
  const sessions = sources.sessions();
  const history = sources.history();
  const handles = new Map(identities.map((identity) => [identity.id, identity.handle]));
  const checkpoints = new Map(sources.forks().flatMap((fork) => (fork.reportedBySession === null ? [] : [[fork.reportedBySession, fork] as const])));
  const scopes = [...sources.scopeMap.scopes.values()].map(({ id, name, driId, testCommand }) => ({ id, name, ownerId: driId, testCommand }));
  const owners = new Set(scopes.map((scope) => scope.ownerId));
  const entries = identities.map((identity): IdentityEntry => {
    const identityOwners = identity.ownerId === null ? identity.teamOwners : [identity.ownerId];
    identityOwners.forEach((owner) => owners.add(owner));
    const own = sessions.get(identity.id) ?? [];
    return {
      id: identity.id,
      handle: identity.handle,
      name: identity.name,
      avatar: avatarUrl(identity.avatar),
      job: identity.job,
      team: identity.ownerId === null,
      owners: identityOwners,
      charterScopes: identity.charterScopes,
      charterPaths: identity.charterPaths,
      charterRules: identity.charterRules,
      autoAccept: identity.autoAccept,
      duplicatedFrom: identity.duplicatedFrom === null ? null : (handles.get(identity.duplicatedFrom) ?? null),
      sessions: own.map(({ id, vendor, branch, worktreeId, status, currentIssueId, lastSeen }) => ({
        id,
        vendor,
        branch,
        worktreeId,
        status,
        currentIssueId,
        lastSeen,
      })),
      history: (history.get(identity.handle) ?? []).flatMap((issueId) => {
        const issue = sources.issue(issueId);
        return issue === undefined ? [] : [{ issueId, title: issue.title, state: issue.state }];
      }),
      lastCheckpoint: lastCheckpoint(own, checkpoints),
      recentOperations: sources.operations(identity.handle),
    };
  });
  return { identities: entries, scopes, owners: [...owners].sort(), limits: { ...IDENTITY_LIMITS } };
}

/**
 * The newest checkpoint among the identity's listed sessions. A fork keeps only its latest
 * checkpoint, so an identity has one only while a session of it reported that latest one.
 */
function lastCheckpoint(sessions: readonly Session[], forks: ReadonlyMap<string, OwnerFork>): IdentityCheckpoint | null {
  let latest: IdentityCheckpoint | null = null;
  for (const session of sessions) {
    const fork = forks.get(session.id);
    if (fork === undefined || fork.latestCheckpointSha === null || fork.reportedAt === null) continue;
    if (latest === null || fork.reportedAt > latest.reportedAt) {
      latest = { sha: fork.latestCheckpointSha, sessionId: session.id, reportedAt: fork.reportedAt };
    }
  }
  return latest;
}

/** An identity store outcome as the dashboard API returns it, without the identity's avatar bytes. */
export function identityWriteOutcome(outcome: IdentityOutcome): IdentityWriteOutcome {
  return outcome.status === "ok"
    ? { status: "ok", id: outcome.identity.id, handle: outcome.identity.handle }
    : outcome;
}

/** The avatar as a `data:` URL, or null. */
export function avatarUrl(avatar: Avatar | null): string | null {
  return avatar === null ? null : `data:${avatar.mediaType};base64,${base64(avatar.data)}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
