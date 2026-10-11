// When a Huddle issue may close (PRD section 6): "IN_REVIEW → CLOSED when every fix is approved, the
// combined tests pass and every thread is resolved", and "Any state → CLOSED (cancelled, by the owner
// who started the work)".
//
// A close as approved also needs its evidence: the Huddle repo's `approved` branch, linked on the
// issue as an `approved` commit at the revision the current checks passed on. Penguin creates that
// branch once nothing else stands in the way, so `closeBlockers` leaves it out and `closeRefusal`,
// which judges the close operation itself, adds it.
//
// Every function here is pure: the caller passes the Huddle issue, its fix sub-issues and the open
// threads it counts.

import { huddleRepoName, type Author, type CloseResolution } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { fixApproval, fixHead, type FixRecord, type LinkedCommitRecord } from "./fix-approval.ts";

/** A check on the Huddle issue, as the issue index holds it. */
export interface CloseCheckRecord {
  readonly commandId: string;
  readonly repo: string;
  readonly sha: string;
  readonly test: string | null;
  readonly result: "pass" | "fail" | "error";
  /** The link that made the result out of date, or null while it is current. */
  readonly supersededBy: string | null;
}

export interface CloseThreadRecord {
  readonly id: string;
  readonly status: "open" | "resolved";
}

/** What the close rule reads from the Huddle issue. */
export interface HuddleCloseRecord {
  readonly id: string;
  readonly state: string;
  readonly checks: ReadonlyMap<string, CloseCheckRecord>;
  readonly linkedCommits: ReadonlyMap<string, LinkedCommitRecord>;
  readonly threads: ReadonlyMap<string, CloseThreadRecord>;
}

/** What the close rule reads from a fix sub-issue. */
export interface FixCloseRecord extends FixRecord {
  readonly id: string;
  readonly threads: ReadonlyMap<string, CloseThreadRecord>;
}

/** An open thread, on the Huddle issue or one of its fixes. */
export interface OpenThread {
  readonly issueId: string;
  readonly threadId: string;
}

export interface CloseInput {
  readonly issue: HuddleCloseRecord;
  readonly fixes: readonly FixCloseRecord[];
  readonly openThreads: readonly OpenThread[];
  readonly scopeMap: ScopeMap;
}

export type CloseRefusal = {
  readonly reason: "close_blocked" | "not_starting_owner";
  readonly message: string;
};

/** The open threads on the Huddle issue and its fixes, as the issue index records them. */
export function openThreadsOf(issue: HuddleCloseRecord, fixes: readonly FixCloseRecord[]): OpenThread[] {
  return [issue, ...fixes].flatMap((record) =>
    [...record.threads.values()]
      .filter((thread) => thread.status === "open")
      .map((thread) => ({ issueId: record.id, threadId: thread.id })),
  );
}

/**
 * The revision every current check on the Huddle issue passed on, `huddle-<id>@<sha>`, or null when
 * there is no current check, one did not pass, or they are not all on one revision of the Huddle repo.
 */
export function verifiedIntegration(issue: HuddleCloseRecord): string | null {
  const current = [...issue.checks.values()].filter((check) => check.supersededBy === null);
  const revisions = new Set(current.map((check) => `${check.repo}@${check.sha}`));
  const [revision] = revisions;
  if (revision === undefined || revisions.size > 1 || current.some((check) => check.result !== "pass")) return null;
  return revision.startsWith(`${huddleRepoName(issue.id)}@`) ? revision : null;
}

/** The commit most recently linked to the issue as `approved`, `<repo>@<sha>`, or null when none is. */
export function approvedCommit(issue: Pick<HuddleCloseRecord, "linkedCommits">): string | null {
  let approved: string | null = null;
  for (const link of issue.linkedCommits.values()) if (link.kind === "approved") approved = `${link.repo}@${link.sha}`;
  return approved;
}

/**
 * What the Huddle waits on before Penguin may record its approved branch, one sentence each; empty
 * when nothing does: the issue is in review, every current check passes on one integration revision,
 * every fix is approved on its head and no thread is open.
 */
export function closeBlockers({ issue, fixes, openThreads, scopeMap }: CloseInput): string[] {
  const blockers: string[] = [];
  if (issue.state !== "in_review") blockers.push(`#${issue.id} is ${issue.state.replace("_", " ")}, not in review.`);
  blockers.push(...checkBlockers(issue));
  for (const fix of fixes) {
    const blocker = fixBlocker(fix, scopeMap);
    if (blocker !== undefined) blockers.push(blocker);
  }
  for (const thread of openThreads) blockers.push(`Thread ${thread.threadId} on #${thread.issueId} is open.`);
  return blockers;
}

function checkBlockers(issue: HuddleCloseRecord): string[] {
  const checks = [...issue.checks.values()];
  const current = checks.filter((check) => check.supersededBy === null);
  if (checks.length === 0) return ["The combined tests have not run."];
  if (current.length === 0) {
    return ["Every check is superseded by a newer checkpoint, and the combined tests have not run on it yet."];
  }
  const failing = current
    .filter((check) => check.result !== "pass")
    .map((check) => `${check.test ?? check.commandId} ${check.result === "fail" ? "fails" : "errored"} on ${check.repo}@${short(check.sha)}.`);
  if (failing.length > 0) return failing;
  if (verifiedIntegration(issue) === null) {
    return [`The current checks are not all on one revision of ${huddleRepoName(issue.id)}'s integration branch.`];
  }
  return [];
}

/** Why the fix lacks a counting approval of its head, or undefined when it has every one it needs. */
function fixBlocker(fix: FixCloseRecord, scopeMap: ScopeMap): string | undefined {
  const approval = fixApproval(fix, scopeMap);
  if (approval.approved) return undefined;
  if (fixHead(fix) === null) return `#${fix.id} has no fix commit to approve.`;
  if (approval.owners.length === 0) return `#${fix.id} has no owner whose review counts.`;
  const owed = approval.owners
    .filter((owner) => owner.state !== "approved")
    .map((owner) => `${owner.owner} (${owner.state === "pending" ? "pending" : "changes requested"})`);
  return `#${fix.id} lacks approval from ${owed.join(", ")}.`;
}

/**
 * Why a close of the Huddle issue by `author` is refused, or undefined when it may close. A cancel
 * comes only from the owner who started the work, `startedBy`, in person. Any other close is judged
 * as approved: nothing may block it (`closeBlockers`) and the approved branch must be linked at the
 * verified integration revision.
 */
export function closeRefusal(
  input: CloseInput & { readonly author: Author; readonly startedBy: string; readonly resolution: CloseResolution | undefined },
): CloseRefusal | undefined {
  const { issue, author, startedBy, resolution } = input;
  if (resolution === "cancelled") {
    if ("person" in author && author.person === startedBy) return undefined;
    return { reason: "not_starting_owner", message: `only ${startedBy}, who started the work, may cancel #${issue.id}` };
  }
  const blockers = closeBlockers(input);
  const integration = verifiedIntegration(issue);
  if (integration !== null && approvedCommit(issue) !== integration) {
    blockers.push(`The approved branch is not recorded at ${integration}.`);
  }
  if (blockers.length === 0) return undefined;
  return { reason: "close_blocked", message: `#${issue.id} cannot close as approved: ${blockers.join(" ")}` };
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
