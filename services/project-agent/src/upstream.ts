// Sending a fix upstream (PRD sections 4, 6 and 12). A session assigned a Huddle's fix sub-issue
// finds that the fix lies outside its identity's charter, in the scope the trigger changed, and
// posts a send_upstream with its reason. The validator and the reducer judge it like any operation:
// only an identity assigned to the issue may send it, only a fix sub-issue has an upstream, and a fix
// whose trigger changed only scopes inside the sender's charter stays with the sender. A rejection
// for one of those reasons is recorded on the issue (`UPSTREAM_RECORDED_REJECTIONS`).
//
// Once the send_upstream applies, Penguin reassigns the sub-issue, as itself and from templates
// only: it assigns an identity of the changing scope's owner, then unassigns the sender. Session
// routing (session-store.ts) then delivers the fix to that identity's running session at its next
// safe checkpoint, or asks the owner to start one.

import { withinCharter, type CharterIdentity, type IssueRecord, type ReduceRejectReason, type RejectReason } from "@penguin/issues";
import type { Party } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { Huddle } from "./huddle-store.ts";
import type { SubmitOutcome } from "./issue-index.ts";

/** The send_upstream rejections the issue records, so the sender and its owner see them there. */
export const UPSTREAM_RECORDED_REJECTIONS: readonly (RejectReason | ReduceRejectReason)[] = [
  "not_assignee",
  "not_a_fix",
  "inside_charter",
];

/** How many times Penguin writes one reassignment step when another writer moved the issue first. */
const REASSIGN_ATTEMPTS = 5;

/**
 * Picks the assignee for a fix sent upstream by `sender`. The upstream scopes are the scopes the
 * trigger changed outside the sender's charter. Their owner is the trigger's owner when that owner
 * holds any of them, else the first such owner by id; a trigger that changed no mapped scope leaves
 * the trigger's owner. Of that owner's personal identities whose charter holds every upstream scope
 * of the owner, the one with the most recently seen running session is chosen, else the first by
 * handle, else the owner in person.
 */
export function upstreamAssignee(
  huddle: Pick<Huddle, "triggerOwner" | "triggerScopes">,
  sender: CharterIdentity | undefined,
  scopeMap: ScopeMap,
  identities: readonly CharterIdentity[],
  runningHandles: readonly string[],
): Party {
  const outside = huddle.triggerScopes.filter(
    (scope) => sender === undefined || !withinCharter(sender, undefined, [scope], [], scopeMap).allowed,
  );
  const ownerOf = (scope: string): string | undefined => scopeMap.scopes.get(scope)?.ownerId;
  const owners = new Set(outside.flatMap((scope) => ownerOf(scope) ?? []));
  const owner = owners.size === 0 || owners.has(huddle.triggerOwner) ? huddle.triggerOwner : [...owners].sort()[0]!;
  const scopes = outside.filter((scope) => ownerOf(scope) === owner);
  const chartered = new Set(
    identities
      .filter(
        (identity) =>
          identity.ownerId === owner &&
          identity.handle !== sender?.handle &&
          scopes.every((scope) => identity.charterScopes.includes(scope)),
      )
      .map((identity) => identity.handle),
  );
  const handle = runningHandles.find((running) => chartered.has(running)) ?? [...chartered].sort()[0];
  return handle === undefined ? { person: owner } : { identity: handle };
}

export interface ReassignDeps {
  /** The Huddle a fix sub-issue belongs to, or undefined for any other issue. */
  readonly huddleOf: (issueId: string) => Huddle | undefined;
  readonly scopeMap: ScopeMap;
  readonly issue: (issueId: string) => IssueRecord | undefined;
  readonly identities: () => readonly CharterIdentity[];
  /** Handles of the identities with a running session, most recently seen first. */
  readonly runningHandles: () => readonly string[];
  /** Signs the operation with the service key and applies it, with Penguin as author. */
  readonly submit: (operation: Record<string, unknown>) => Promise<SubmitOutcome>;
}

export type Reassignment =
  | { readonly status: "reassigned"; readonly assignee: Party }
  | { readonly status: "failed"; readonly message: string };

/**
 * Penguin's reassignment of a fix sub-issue `sender` sent upstream: it assigns the upstream assignee
 * and unassigns the sender. Each step first reads the issue and skips what is already there.
 */
export async function reassignUpstream(deps: ReassignDeps, issueId: string, sender: string): Promise<Reassignment> {
  const huddle = deps.huddleOf(issueId);
  if (huddle === undefined) return { status: "failed", message: `issue ${issueId} is not a fix sub-issue` };
  const identities = deps.identities();
  const assignee = upstreamAssignee(
    huddle,
    identities.find((identity) => identity.handle === sender),
    deps.scopeMap,
    identities,
    deps.runningHandles(),
  );
  const steps: [type: "assign" | "unassign", party: Party, wanted: boolean][] = [
    ["assign", assignee, true],
    ["unassign", { identity: sender }, false],
  ];
  for (const [type, party, wanted] of steps) {
    const failure = await ensureAssignment(deps, issueId, type, party, wanted);
    if (failure !== undefined) return { status: "failed", message: failure };
  }
  return { status: "reassigned", assignee };
}

/** Writes the assign or unassign unless the issue already has `party` assigned as `wanted`. */
async function ensureAssignment(
  deps: ReassignDeps,
  issueId: string,
  type: "assign" | "unassign",
  party: Party,
  wanted: boolean,
): Promise<string | undefined> {
  const key = "identity" in party ? `identity:${party.identity}` : `person:${party.person}`;
  for (let attempt = 1; ; attempt += 1) {
    const issue = deps.issue(issueId);
    if (issue === undefined) return `issue ${issueId} is missing from the index`;
    if (issue.assignments.has(key) === wanted) return undefined;
    const outcome = await deps.submit({
      issue: Number(issueId),
      type,
      base_version: issue.version,
      payload: { assignee: party },
    });
    if (outcome.status === "applied") return undefined;
    // Another writer moved the issue between the read and the write: read it again.
    if (outcome.reason !== "superseded_version" || attempt === REASSIGN_ATTEMPTS) {
      return `${type} on #${issueId} was rejected: ${outcome.reason}: ${outcome.message}`;
    }
  }
}
