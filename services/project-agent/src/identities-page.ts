// Builds the dashboard's identities page (PRD section 8: "create, edit and duplicate identities; set
// each charter; see each identity's sessions and issue history") from the identity store, the session
// router, the issue index and the scope map. The result is plain JSON for Durable Object RPC.

import type { IssueRecord } from "@penguin/issues";
import type { IdentitiesPage, IdentityEntry, IdentityWriteOutcome } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { IDENTITY_LIMITS, type Avatar, type Identity, type IdentityOutcome } from "./identity-store.ts";
import type { Session } from "./session-store.ts";

/** How many of an identity's sessions the page lists, most recent first. */
export const PAGE_SESSIONS_PER_IDENTITY = 10;

export interface IdentitiesPageSources {
  identities(): readonly Identity[];
  /** Each identity's sessions by identity id (SessionStore.byIdentity). */
  sessions(): ReadonlyMap<string, readonly Session[]>;
  /** Each handle's issue ids, most recent first (IssueIndex.identityHistory). */
  history(): ReadonlyMap<string, readonly string[]>;
  issue(id: string): IssueRecord | undefined;
  scopeMap: ScopeMap;
}

export function buildIdentitiesPage(sources: IdentitiesPageSources): IdentitiesPage {
  const identities = sources.identities();
  const sessions = sources.sessions();
  const history = sources.history();
  const handles = new Map(identities.map((identity) => [identity.id, identity.handle]));
  const scopes = [...sources.scopeMap.scopes.values()].map(({ id, name, ownerId, testCommand }) => ({ id, name, ownerId, testCommand }));
  const owners = new Set(scopes.map((scope) => scope.ownerId));
  const entries = identities.map((identity): IdentityEntry => {
    const identityOwners = identity.ownerId === null ? identity.teamOwners : [identity.ownerId];
    identityOwners.forEach((owner) => owners.add(owner));
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
      sessions: (sessions.get(identity.id) ?? []).map(({ id, vendor, branch, status, lastSeen }) => ({
        id,
        vendor,
        branch,
        status,
        lastSeen,
      })),
      history: (history.get(identity.handle) ?? []).flatMap((issueId) => {
        const issue = sources.issue(issueId);
        return issue === undefined ? [] : [{ issueId, title: issue.title, state: issue.state }];
      }),
    };
  });
  return { identities: entries, scopes, owners: [...owners].sort(), limits: { ...IDENTITY_LIMITS } };
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
