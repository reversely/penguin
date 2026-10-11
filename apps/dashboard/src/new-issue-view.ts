// What the New issue form and the issue page's assign control send through POST /api/operations. Pure,
// with the reads and writes passed in, so the sequence is tested without a browser
// (test/new-issue-view.test.ts).
//
// The dashboard names a new issue by number: the next one after the highest on the board. Two people
// who open an issue at the same moment pick the same number. Penguin rejects the second create as
// issue_exists, so the form reads the board again and takes the next number.

import type { IssuePageAssignee } from "@penguin/protocol";

import type { WriteOutcome } from "./api.ts";

/** The operation schema's caps on a title and a body (packages/protocol/src/operation-schema.ts). */
export const TITLE_MAX_LENGTH = 256;
export const BODY_MAX_LENGTH = 32_768;

/** How many numbers the form tries before it gives up on a busy board. */
const CREATE_ATTEMPTS = 3;

export interface DashboardOperation {
  readonly issue: number | string;
  readonly type: string;
  readonly base_version: number;
  readonly payload: Record<string, unknown>;
}

export interface NewIssue {
  readonly title: string;
  readonly body: string;
  /** Identity handles to assign once the issue exists, such as "@jun/reports". */
  readonly assignees: readonly string[];
}

export interface OpenIssueSources {
  /** Every issue id on the board, read fresh. */
  issueIds(): Promise<readonly string[]>;
  submit(operation: DashboardOperation): Promise<WriteOutcome>;
}

export type OpenedIssue =
  | {
      readonly status: "opened";
      readonly issueId: string;
      readonly opIds: readonly string[];
      /** Handles whose assign was rejected; the issue exists without them. */
      readonly unassigned: readonly string[];
    }
  | { readonly status: "rejected"; readonly reason: string };

/** One more than the highest numbered issue; temporary IDs do not count. */
export function nextIssueNumber(issueIds: readonly string[]): number {
  const numbers = issueIds.filter((id) => /^[0-9]+$/.test(id)).map(Number);
  return Math.max(0, ...numbers) + 1;
}

/** Why the form cannot be sent yet, or undefined when it can. */
export function newIssueProblem(issue: Pick<NewIssue, "title">): string | undefined {
  return issue.title.trim() === "" ? "Please enter a title" : undefined;
}

/** Creates the issue, then assigns each identity in turn, each on the version the last write left. */
export async function openIssue(issue: NewIssue, sources: OpenIssueSources): Promise<OpenedIssue> {
  const payload: Record<string, unknown> = { title: issue.title.trim() };
  if (issue.body.trim() !== "") payload["body"] = issue.body;

  let created: Extract<WriteOutcome, { status: "applied" }> | undefined;
  for (let attempt = 0; created === undefined; attempt += 1) {
    const number = nextIssueNumber(await sources.issueIds());
    const outcome = await sources.submit({ issue: number, type: "create", base_version: 0, payload });
    if (outcome.status === "applied") created = outcome;
    else if (outcome.reason !== "issue_exists" || attempt + 1 === CREATE_ATTEMPTS) return { status: "rejected", reason: outcome.reason };
  }

  const opIds = [created.opId];
  const unassigned: string[] = [];
  let version = created.version;
  for (const [position, handle] of issue.assignees.entries()) {
    // The issue exists now, so a failed write must not send the person back to Create, which would
    // open it twice; the handles left over are reported instead.
    const outcome = await sources
      .submit(assignOperation(created.issueId, version, "assign", { kind: "identity", id: handle }))
      .catch(() => undefined);
    if (outcome === undefined) {
      unassigned.push(...issue.assignees.slice(position));
      break;
    }
    if (outcome.status === "applied") {
      opIds.push(outcome.opId);
      version = outcome.version;
    } else {
      unassigned.push(handle);
    }
  }
  return { status: "opened", issueId: created.issueId, opIds, unassigned };
}

/** An assign or unassign of a person or an identity, as the issue page and the form send it. */
export function assignOperation(
  issueId: string,
  version: number,
  type: "assign" | "unassign",
  assignee: Pick<IssuePageAssignee, "kind" | "id">,
): DashboardOperation {
  return {
    issue: Number(issueId),
    type,
    base_version: version,
    payload: { assignee: assignee.kind === "person" ? { person: assignee.id } : { identity: assignee.id } },
  };
}

/** The identity handles the issue page offers to assign: those not assigned already. */
export function assignChoices(handles: readonly string[], assignees: readonly Pick<IssuePageAssignee, "kind" | "id">[]): string[] {
  const taken = new Set(assignees.filter((assignee) => assignee.kind === "identity").map((assignee) => assignee.id));
  return handles.filter((handle) => !taken.has(handle));
}
