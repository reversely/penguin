// What GET /api/issues/<id> returns to the dashboard: one issue, its sub-issues and its timeline, as
// plain JSON. The ProjectAgent builds it from the issue index and the session router
// (services/project-agent/src/issue-page.ts); the issue page renders it (apps/dashboard).

export type IssuePageState = "open" | "detected" | "fixing" | "verifying" | "in_review" | "closed";

/** The running or last session an identity assignment routed to. */
export interface IssuePageSession {
  readonly id: string;
  readonly vendor: string;
  readonly branch: string;
  readonly status: "running" | "offline";
}

export interface IssuePageAssignee {
  readonly kind: "person" | "identity";
  /** A person id, or an identity handle such as "@jun/reports". */
  readonly id: string;
  /** The session the issue is routed to, for an identity; null otherwise. */
  readonly session: IssuePageSession | null;
  /** What an identity assignment waits for before it routes, or null. */
  readonly waitingFor: "acceptance" | "session" | null;
}

export interface IssuePageCommit {
  readonly opId: string;
  readonly repo: string;
  readonly sha: string;
  readonly kind: "trigger" | "fix" | "related" | null;
  /** The author segment of the operation that linked the commit, or null when it is not known. */
  readonly linkedBy: string | null;
}

export interface IssuePageCheck {
  readonly opId: string;
  /** The allowlisted command the runner ran: the environment the result applies to. */
  readonly commandId: string;
  readonly repo: string;
  /** The revision the result applies to. */
  readonly sha: string;
  readonly test: string | null;
  readonly result: "pass" | "fail" | "error";
  readonly logRef: string | null;
  /** What the result applies to: the SHA-256 of the tested commit, its lockfiles and the command ID. */
  readonly fingerprint: string | null;
  /**
   * The op_id of the `link_commit` whose newer checkpoint made this result out of date, or null while
   * it is current. A superseded check never counts.
   */
  readonly supersededBy: string | null;
}

export interface IssuePageReview {
  readonly opId: string;
  /** The reviewer's author segment. */
  readonly reviewer: string;
  readonly verdict: "approve" | "request_changes";
  readonly reason: string | null;
  readonly repo: string;
  readonly sha: string;
  /** False for a review from someone without review rights; `uncountedReason` says why. */
  readonly counts: boolean;
  readonly uncountedReason: string | null;
}

/** Where one owner whose review counts on a fix stands on the fix's head. */
export interface IssuePageOwnerApproval {
  readonly owner: string;
  readonly state: "approved" | "changes_requested" | "pending";
  /** Who wrote the standing review: the owner, or the owner's delegate; null while pending. */
  readonly reviewer: string | null;
  readonly reviewOpId: string | null;
  readonly reason: string | null;
}

/**
 * Where approval of a Huddle fix stands, as its HuddleAgent last reported it. Only a review of the
 * head counts; one of an older commit was superseded.
 */
export interface IssuePageApproval {
  /** The fix commit under review, `<repo>@<sha>`, or null while none is linked. */
  readonly head: string | null;
  /** The owner of each scope labelled on the fix, sorted. */
  readonly owners: readonly IssuePageOwnerApproval[];
  /** True when every owner approved the head. */
  readonly approved: boolean;
}

export interface IssuePageThread {
  /** The op_id of the open_thread operation, which replies and the resolution name. */
  readonly id: string;
  readonly status: "open" | "resolved";
  readonly needsPersonIds: readonly string[];
  readonly body: string;
  /** What the thread is about, such as `review:<op_id>` for a request for changes; null when unstated. */
  readonly anchor: string | null;
  /** The author segment of whoever opened the thread. */
  readonly openedBy: string;
  /** Author segments of everyone who opened, replied to or resolved the thread. */
  readonly participants: readonly string[];
  readonly resolvedBy: string | null;
  readonly resolveReason: string | null;
}

export interface IssuePageSubIssue {
  readonly id: string;
  readonly title: string;
  readonly state: IssuePageState;
  readonly assignees: readonly IssuePageAssignee[];
  readonly reviews: readonly IssuePageReview[];
  readonly checks: readonly IssuePageCheck[];
  /** Where approval stands, for a Huddle fix whose reviews are being collected; null otherwise. */
  readonly approval: IssuePageApproval | null;
}

/** One operation recorded against the issue, applied or rejected, in apply order. */
export interface IssuePageTimelineEntry {
  readonly seq: number;
  readonly opId: string;
  /** The author segment, or null for a file that could not be read as an operation. */
  readonly author: string | null;
  readonly type: string | null;
  readonly payload: unknown;
  readonly status: "applied" | "rejected";
  readonly rejectReason: string | null;
  readonly message: string | null;
  readonly gitCommit: string | null;
  /** True while the operation is applied in the index but not yet pushed to the issues repo. */
  readonly waitingForGitLog: boolean;
}

export interface IssuePage {
  readonly issue: {
    /** The issue's number as text. */
    readonly id: string;
    /** The temporary ID of an issue created offline, which resolves to `id`; null otherwise. */
    readonly alias: string | null;
    readonly title: string;
    readonly body: string;
    readonly state: IssuePageState;
    readonly stateReason: string | null;
    readonly labels: readonly string[];
    readonly parentId: string | null;
    /** The number of operations applied to the issue; a new operation's base_version. */
    readonly version: number;
    readonly assignees: readonly IssuePageAssignee[];
    readonly commits: readonly IssuePageCommit[];
    readonly checks: readonly IssuePageCheck[];
    readonly reviews: readonly IssuePageReview[];
    readonly threads: readonly IssuePageThread[];
  };
  readonly subIssues: readonly IssuePageSubIssue[];
  readonly timeline: readonly IssuePageTimelineEntry[];
}
