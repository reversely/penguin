// The dashboard API client. Every call sends the session cookie; a 401 means the session ended.

import type {
  Board,
  FeaturePage,
  IdentitiesPage,
  IdentityWriteOutcome,
  Inbox,
  InboxEntry,
  IssuePage,
  OverlapRequest,
  OverlapRequests,
  PersonScopes,
  PlanInbox,
  ReviewDifferences,
  ReviewPolicy,
  ReviewPolicyView,
  TeamView,
  ViewerPlan,
} from "@penguin/protocol";

export interface Session {
  readonly owner: string;
  readonly login: string;
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

export async function fetchInbox(): Promise<readonly InboxEntry[]> {
  return (await getJson<Inbox>("/api/inbox")).items;
}

/**
 * Marks one of the signed-in person's inbox items read. Resolves false when the inbox no longer holds
 * the item.
 */
export async function markInboxRead(item: Pick<InboxEntry, "issueId" | "reason">): Promise<boolean> {
  const response = await fetch("/api/inbox/read", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ issueId: item.issueId, reason: item.reason }),
  });
  await response.arrayBuffer();
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`/api/inbox/read answered ${response.status}`);
  return true;
}

/** The overlapping starts that wait for the signed-in person's approval. */
export async function fetchOverlapRequests(): Promise<readonly OverlapRequest[]> {
  return (await getJson<OverlapRequests>("/api/overlaps")).requests;
}

/**
 * Approves the start of `blockedFeature` beside the person's own `feature`. The server names the
 * approver from the session. Resolves false when the lock is no longer open.
 */
export async function approveOverlap(request: Pick<OverlapRequest, "feature" | "blockedFeature">): Promise<boolean> {
  const response = await fetch("/api/overlaps/approve", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ feature: request.feature, blockedFeature: request.blockedFeature }),
  });
  await response.arrayBuffer();
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404 || response.status === 409) return false;
  if (!response.ok) throw new Error(`/api/overlaps/approve answered ${response.status}`);
  return true;
}

/** The merge plan parts and review exceptions waiting on the signed-in person. */
export async function fetchPlanInbox(): Promise<PlanInbox> {
  return getJson<PlanInbox>("/api/plan-parts");
}

/** One decision on one revision of a plan part; the server names the decider from the session. */
export type PlanPartDecision =
  | { readonly kind: "approve" | "reverse"; readonly feature: string; readonly part: string; readonly revision: number }
  | { readonly kind: "request_change"; readonly feature: string; readonly part: string; readonly revision: number; readonly text: string };

const DECISION_PATH: Readonly<Record<PlanPartDecision["kind"], string>> = {
  approve: "/api/plan-parts/approve",
  reverse: "/api/plan-parts/reverse",
  request_change: "/api/plan-parts/request-change",
};

/**
 * Approves a part's revision, reverses Penguin's approval of it or asks for a change to it. Resolves
 * false when the part moved on since it was read.
 */
export async function decidePlanPart({ kind, ...decision }: PlanPartDecision): Promise<boolean> {
  const path = DECISION_PATH[kind];
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(decision),
  });
  await response.arrayBuffer();
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404 || response.status === 409) return false;
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return true;
}

/**
 * Confirms the lines a feature's own change writes under `owner`'s custom path rules, at the checkpoint
 * read; the server names the confirmer from the session. Resolves false when the change moved on.
 */
export async function confirmProtectedChange(change: { readonly feature: string; readonly owner: string; readonly checkpoint: string }): Promise<boolean> {
  const path = "/api/plan-parts/confirm-protected";
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ feature: change.feature, owner: change.owner, checkpoint: change.checkpoint }),
  });
  await response.arrayBuffer();
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404 || response.status === 409) return false;
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return true;
}

/**
 * Decides one caller item sent to the signed-in person as its worktree owner: approve, or request
 * changes with `text`; the server names the decider from the session. Resolves false when the item
 * moved on since it was read.
 */
export async function decideCallerItem(decision: { readonly item: string; readonly verdict: "approve" | "request_changes"; readonly text: string }): Promise<boolean> {
  const path = "/api/plan-parts/decide-caller";
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ item: decision.item, verdict: decision.verdict, text: decision.text }),
  });
  await response.arrayBuffer();
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404 || response.status === 409) return false;
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return true;
}

export async function fetchIdentities(): Promise<IdentitiesPage> {
  return getJson<IdentitiesPage>("/api/identities");
}

/**
 * Creates (`/api/identities`), edits (`/api/identities/<id>`) or duplicates
 * (`/api/identities/<id>/duplicate`) an identity as the signed-in person.
 */
export async function writeIdentity(path: string, body: Readonly<Record<string, unknown>>): Promise<IdentityWriteOutcome> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    await response.arrayBuffer();
    throw new SignedOut();
  }
  // The ProjectAgent's outcome comes with 200, 201, 403, 404 or 422; the Worker's own refusals carry none.
  const answer: unknown = await response.json().catch(() => undefined);
  if (typeof answer === "object" && answer !== null && "status" in answer) return answer as IdentityWriteOutcome;
  throw new Error(`${path} answered ${response.status}`);
}

/** The sandbox's review policy, who changed it, whether the signed-in person may and the split of approvals. */
export async function fetchReviewPolicy(): Promise<ReviewPolicyView> {
  return getJson<ReviewPolicyView>("/api/review-policy");
}

/**
 * Sets the review policy as the signed-in person, a team lead. Resolves false when the ProjectAgent
 * refuses it: the person leads no team, or admin mode locks the policy.
 */
export async function changeReviewPolicy(policy: ReviewPolicy): Promise<boolean> {
  const path = "/api/review-policy";
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ preset: policy.preset, rows: policy.rows }),
  });
  await response.arrayBuffer();
  if (response.status === 401) throw new SignedOut();
  if (response.status === 403 || response.status === 422) return false;
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return true;
}

/** Every person with their role, their features with each state and agents, and their idle agents. */
export async function fetchTeam(): Promise<TeamView> {
  return getJson<TeamView>("/api/team");
}

/** One person's role with every list in full, for the person page's tables. */
export async function fetchPersonScopes(person: string): Promise<PersonScopes> {
  return getJson<PersonScopes>(`/api/people/${encodeURIComponent(person)}/scopes`);
}

/** A feature's page as the signed-in person may see it, or undefined for no such feature. */
export async function fetchFeaturePage(featureId: string): Promise<FeaturePage | undefined> {
  try {
    return await getJson<FeaturePage>(`/api/features/${encodeURIComponent(featureId)}/page`);
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

/**
 * A feature's newest plan as the signed-in person may see it, read when they expand a file the page
 * cut; undefined for no feature or no plan.
 */
export async function fetchFeaturePlan(featureId: string): Promise<ViewerPlan | undefined> {
  try {
    return await getJson<ViewerPlan>(`/api/features/${encodeURIComponent(featureId)}/plan`);
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

/** Every differing input of a review's side-by-side run, read when a person opens a set's full table. */
export async function fetchReviewDifferences(reviewId: number): Promise<ReviewDifferences> {
  return getJson<ReviewDifferences>(`/api/reviews/${reviewId}/differences`);
}

export async function fetchBoard(): Promise<Board> {
  return getJson<Board>("/api/board");
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
