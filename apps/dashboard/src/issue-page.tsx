// The issue page (PRD section 8; identity plan sections 4 and 5). The centre holds the issue's
// activity (issue-thread.tsx): the description, the timeline with rejected operations and their
// reasons, checks as evidence cards, reviews and fix approvals as approval cards, the threads with a
// reply box and Resolve, and the comment composer. The details panel holds Penguin's state, the
// labels, the assignees with their sessions and controls to assign an identity or unassign anyone,
// a summary of the checks, the sub-issues with their reviews, the close-out, the trigger and the
// commits. From 1100px the panel docks beside the activity; below, it is the shell's drawer; on a
// phone an Activity and Details control switches the page between the two. Every value from the issue
// renders as React text, so markup in an issue body or comment shows as text and runs nothing.
//
// The page shows no diff. Another owner's unfinished work appears only as linked commits and checks;
// the diff viewer, which shows the affected hunks only (open decision 2), is a later ticket.

import type { IssuePage, IssuePageAssignee, IssuePageCloseOut, IssuePageReview, IssuePageSubIssue } from "@penguin/protocol";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from "react";

import { fetchIssue, SignedOut, submitOperation } from "./api.ts";
import { IdentityAvatar, PersonAvatar } from "./avatar.tsx";
import { DetailsPanel, DetailsToggle } from "./details-pane.tsx";
import { Icon } from "./icon.tsx";
import { AuthorName, PenguinIndicator, SignalTag, type Authors } from "./issue-marks.tsx";
import { IssueThread } from "./issue-thread.tsx";
import {
  APPROVAL_LABEL,
  assigneeSegment,
  authorName,
  checkSummary,
  penguinState,
  RESOLUTION_LABEL,
  reviewSuperseded,
  shortSha,
  showsCloseOut,
  STATE_LABEL,
  watchedIssues,
} from "./issue-view.ts";
import { latestChange } from "./live-changes.ts";
import { linkHandler } from "./links.ts";
import { assignChoices, assignOperation } from "./new-issue-view.ts";
import { useIdentityHandles, type IdentityHandles, type KnownIdentities } from "./use-identity-handles.ts";
import type { Live } from "./use-live.ts";
import { useOperation } from "./use-operation.ts";

export { PenguinIndicator, SignalTag } from "./issue-marks.tsx";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: IssuePage }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

interface Props {
  readonly issueId: string;
  /** The signed-in person, whose comments show in ink and whose pending reviews take actions. */
  readonly viewer: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

/** The width below which the shell shows its phone layout; matches app.css. */
const PHONE = "(max-width: 759.98px)";

function usePhone(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(PHONE);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

const NO_IDENTITIES: KnownIdentities = new Map();

export function IssuePageView({ issueId, viewer, live, navigate, onSignedOut }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const page = load.kind === "ready" && routeMatches(load.page, issueId) ? load.page : undefined;
  const change = latestChange(live, watchedIssues(page, issueId));
  const connected = live.status === "live";
  const identities = useIdentityHandles(live, onSignedOut);
  const phone = usePhone();

  useEffect(() => {
    let current = true;
    fetchIssue(issueId).then(
      (read) => {
        if (current) setLoad(read === undefined ? { kind: "missing" } : { kind: "ready", page: read });
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        else if (current) setLoad({ kind: "failed" });
      },
    );
    return () => {
      current = false;
    };
    // `connected` reads the issue again after a reconnect, which may have missed a change.
  }, [issueId, change, reload, connected, onSignedOut]);

  if (load.kind === "missing") {
    return (
      <div className="issue">
        <h1>Issue not found</h1>
        <p className="muted">Please check the issue number</p>
      </div>
    );
  }
  if (load.kind === "failed" && page === undefined) {
    return (
      <div className="issue">
        <h1>Issue {issueId}</h1>
        <p className="notice" role="alert">
          Please reload the page
        </p>
      </div>
    );
  }
  if (page === undefined) {
    return (
      <div className="issue" aria-busy="true">
        {phone ? null : <DetailsPanel />}
      </div>
    );
  }
  return (
    <IssueContent
      page={page}
      viewer={viewer}
      identities={identities}
      phone={phone}
      navigate={navigate}
      onSignedOut={onSignedOut}
      onWritten={() => setReload((value: number) => value + 1)}
    />
  );
}

function routeMatches(page: IssuePage, issueId: string): boolean {
  return page.issue.id === issueId || page.issue.alias === issueId;
}

export function IssueContent({
  page,
  viewer,
  identities,
  phone,
  navigate,
  onSignedOut,
  onWritten,
}: {
  page: IssuePage;
  viewer: string;
  identities: IdentityHandles;
  phone: boolean;
  navigate: (path: string) => void;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const { issue } = page;
  const [view, setView] = useState<"thread" | "details">("thread");
  const known = identities.kind === "ready" ? identities.known : NO_IDENTITIES;
  const authors = useMemo<Authors>(() => ({ known, navigate }), [known, navigate]);
  const details = <IssueDetails page={page} identities={identities} authors={authors} navigate={navigate} onSignedOut={onSignedOut} onWritten={onWritten} />;
  return (
    <article className="issue">
      <header className="issue-header">
        <h1>
          <span className="issue-number">#{issue.id}</span> {issue.title}
        </h1>
        {phone ? null : <DetailsToggle />}
        <div className="issue-status">
          <span className={`tag state state-${issue.state}`}>{STATE_LABEL[issue.state]}</span>
          {issue.parentId === null ? null : (
            <a className="tag" href={`/issues/${issue.parentId}`} onClick={linkHandler(navigate, `/issues/${issue.parentId}`)}>
              <Icon name="back" />
              Sub-issue of #{issue.parentId}
            </a>
          )}
        </div>
        {phone ? (
          <div className="segmented issue-views" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "thread"} onClick={() => setView("thread")}>
              Activity
            </button>
            <button type="button" aria-pressed={view === "details"} onClick={() => setView("details")}>
              Details
            </button>
          </div>
        ) : null}
      </header>

      {/* On a phone both views stay mounted, so a draft in the composer survives a switch. */}
      <div hidden={phone && view !== "thread"}>
        <IssueThread page={page} viewer={viewer} authors={authors} navigate={navigate} onSignedOut={onSignedOut} onWritten={onWritten} />
      </div>
      {phone ? (
        <div className="issue-side issue-details-inline" hidden={view !== "details"}>
          {details}
        </div>
      ) : (
        <DetailsPanel>{details}</DetailsPanel>
      )}
    </article>
  );
}

function IssueDetails({
  page,
  identities,
  authors,
  navigate,
  onSignedOut,
  onWritten,
}: {
  page: IssuePage;
  identities: IdentityHandles;
  authors: Authors;
  navigate: (path: string) => void;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const { issue } = page;
  const trigger = issue.commits.filter((commit) => commit.kind === "trigger");
  const otherCommits = issue.commits.filter((commit) => commit.kind !== "trigger");
  return (
    <>
      <section className="panel" aria-labelledby="issue-penguin">
        <h2 id="issue-penguin">Penguin</h2>
        <p className="row">
          <PenguinIndicator state={penguinState(page)} />
        </p>
      </section>

      <section className="panel" aria-labelledby="issue-labels">
        <h2 id="issue-labels">Labels</h2>
        {issue.labels.length === 0 ? (
          <p className="muted">No labels</p>
        ) : (
          <ul className="tags">
            {issue.labels.map((label) => (
              <li key={label} className="tag tag-data">
                {label}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AssigneesPanel issue={issue} identities={identities} authors={authors} onSignedOut={onSignedOut} onWritten={onWritten} />

      <ChecksSummary checks={issue.checks} />

      <section className="panel" aria-labelledby="issue-sub-issues">
        <h2 id="issue-sub-issues">Sub-issues</h2>
        {page.subIssues.length === 0 ? (
          <p className="muted">No sub-issues</p>
        ) : (
          <ul className="rows">
            {page.subIssues.map((sub) => (
              <SubIssueRow key={sub.id} sub={sub} authors={authors} navigate={navigate} />
            ))}
          </ul>
        )}
      </section>

      {showsCloseOut(issue.closeOut) ? <CloseOutPanel closeOut={issue.closeOut} /> : null}

      <section className="panel" aria-labelledby="issue-trigger">
        <h2 id="issue-trigger">Trigger</h2>
        {trigger.length === 0 ? (
          <p className="muted">No trigger commit</p>
        ) : (
          <ul className="rows">
            {trigger.map((commit) => (
              <li key={commit.opId} className="row">
                <code className="revision">
                  {commit.repo}@{shortSha(commit.sha)}
                </code>
                <span className="muted">{authorName(commit.linkedBy)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {otherCommits.length === 0 ? null : (
        <section className="panel" aria-labelledby="issue-commits">
          <h2 id="issue-commits">Commits</h2>
          <ul className="rows">
            {otherCommits.map((commit) => (
              <li key={commit.opId} className="row">
                {commit.kind === null ? null : <span className="tag tag-data">{commit.kind}</span>}
                <code className="revision">
                  {commit.repo}@{shortSha(commit.sha)}
                </code>
                <span className="muted">{authorName(commit.linkedBy)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The current checks counted by signal, and the superseded ones; each check's card is in the thread. */
function ChecksSummary({ checks }: { checks: IssuePage["issue"]["checks"] }) {
  const summary = checkSummary(checks);
  return (
    <section className="panel" aria-labelledby="issue-checks">
      <h2 id="issue-checks">Checks</h2>
      {checks.length === 0 ? (
        <p className="muted">No checks yet</p>
      ) : (
        <p className="row check-summary">
          {summary.verified === 0 ? null : <SignalTag signal="verified">{`${summary.verified} Verified`}</SignalTag>}
          {summary.failure === 0 ? null : <SignalTag signal="failure">{`${summary.failure} Failed`}</SignalTag>}
          {summary.warning === 0 ? null : <SignalTag signal="warning">{`${summary.warning} Warning`}</SignalTag>}
          {summary.superseded === 0 ? null : <span className="tag tag-data tag-superseded">{`${summary.superseded} Superseded`}</span>}
        </p>
      )}
    </section>
  );
}

/** How the issue closed and its approved branch, or what a Huddle issue waits on before it closes. */
function CloseOutPanel({ closeOut }: { closeOut: IssuePageCloseOut }) {
  const at = closeOut.approvedCommit?.indexOf("@") ?? -1;
  return (
    <section className="panel" aria-labelledby="issue-close-out">
      <h2 id="issue-close-out">Close-out</h2>
      {closeOut.resolution === null ? null : <p>{RESOLUTION_LABEL[closeOut.resolution]}</p>}
      {closeOut.approvedCommit === null ? null : (
        <p className="row">
          <span className="tag signal signal-verified">approved</span>
          <code className="revision">
            {closeOut.approvedCommit.slice(0, at)}@{shortSha(closeOut.approvedCommit.slice(at + 1))}
          </code>
        </p>
      )}
      {closeOut.waitingOn.length === 0 ? null : (
        <ul className="rows close-out-waiting">
          {closeOut.waitingOn.map((line) => (
            <li key={line} className="row">
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SubIssueRow({ sub, authors, navigate }: { sub: IssuePageSubIssue; authors: Authors; navigate: (path: string) => void }) {
  return (
    <li className="sub-issue">
      <div className="sub-issue-head">
        <a className="row-title" href={`/issues/${sub.id}`} onClick={linkHandler(navigate, `/issues/${sub.id}`)}>
          #{sub.id} {sub.title}
        </a>
        <span className={`tag state state-${sub.state}`}>{STATE_LABEL[sub.state]}</span>
      </div>
      {sub.assignees.length === 0 ? null : (
        <ul className="rows">
          {sub.assignees.map((assignee) => (
            <li key={`${assignee.kind}:${assignee.id}`} className="row">
              <Assignee assignee={assignee} authors={authors} />
            </li>
          ))}
        </ul>
      )}
      {sub.approval === null || sub.approval.owners.length === 0 ? null : (
        <ul className="rows">
          {sub.approval.owners.map((owner) => (
            <li key={owner.owner} className="row">
              <span className={`tag approval-owner-state owner-${owner.state}`}>{APPROVAL_LABEL[owner.state]}</span>
              <span className="row-title">{authorName(owner.owner)}</span>
              {owner.reviewer === null || owner.reviewer === owner.owner ? null : (
                <span className="muted">by delegate {authorName(owner.reviewer)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {sub.reviews.length === 0 ? null : (
        <ul className="rows">
          {sub.reviews.map((review) => (
            <li key={review.opId} className="row">
              <ReviewTags review={review} superseded={reviewSuperseded(review, sub.approval)} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Assignee({ assignee, authors, nameId }: { assignee: IssuePageAssignee; authors: Authors; nameId?: string }) {
  return (
    <>
      {assignee.kind === "identity" ? (
        <IdentityAvatar handle={assignee.id} image={authors.known.get(assignee.id)?.avatar ?? null} size="card" />
      ) : (
        <PersonAvatar id={assignee.id} size="card" />
      )}
      <span id={nameId} className="row-title">
        <AuthorName segment={assigneeSegment(assignee)} authors={authors} className="assignee-name" />
      </span>
      {assignee.session === null ? null : (
        <>
          <span className={`tag session-${assignee.session.status}`}>{assignee.session.status}</span>
          <span className="tag tag-data">{assignee.session.vendor}</span>
          <code className="muted">{assignee.session.branch}</code>
        </>
      )}
      {assignee.waitingFor === null ? null : (
        <span className="tag tag-data">{assignee.waitingFor === "acceptance" ? "Awaiting acceptance" : "Awaiting a session"}</span>
      )}
    </>
  );
}

function ReviewTags({ review, superseded = false }: { review: IssuePageReview; superseded?: boolean }) {
  return (
    <>
      <SignalTag signal="review">{review.verdict === "approve" ? "Approved" : "Changes requested"}</SignalTag>
      <span className="row-title">{authorName(review.reviewer)}</span>
      {review.counts ? null : (
        <span className="tag tag-data" title={review.uncountedReason ?? undefined}>
          Not counted
        </span>
      )}
      {superseded ? (
        <span className="tag tag-data" title={`Reviewed ${review.repo}@${shortSha(review.sha)}, an older commit than the fix's head`}>
          Older commit
        </span>
      ) : null}
    </>
  );
}

/** The assignees, each with Unassign, and a choice of identity to assign. */
function AssigneesPanel({
  issue,
  identities,
  authors,
  onSignedOut,
  onWritten,
}: {
  issue: IssuePage["issue"];
  identities: IdentityHandles;
  authors: Authors;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const [chosen, setChosen] = useState("");
  const operation = useOperation(onSignedOut, onWritten);
  const sending = operation.sending !== undefined;
  const choices = identities.kind === "ready" ? assignChoices(identities.handles, issue.assignees) : [];

  const write = (type: "assign" | "unassign", assignee: Pick<IssuePageAssignee, "kind" | "id">) =>
    operation.send(
      type,
      () => submitOperation(assignOperation(issue.id, issue.version, type, assignee)),
      () => {
        if (type === "assign") setChosen("");
      },
    );

  const assign = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (chosen !== "") write("assign", { kind: "identity", id: chosen });
  };

  return (
    <section className="panel" aria-labelledby="issue-assignees">
      <h2 id="issue-assignees">Assignees</h2>
      {issue.assignees.length === 0 ? (
        <p className="muted">No assignees</p>
      ) : (
        <ul className="rows">
          {issue.assignees.map((assignee) => {
            const key = `${assignee.kind}:${assignee.id}`;
            return (
              <li key={key} className="row assignee">
                <Assignee assignee={assignee} authors={authors} nameId={`assignee-${key}`} />
                <button
                  type="button"
                  className="button assignee-remove"
                  disabled={sending}
                  aria-describedby={`assignee-${key}`}
                  onClick={() => write("unassign", assignee)}
                >
                  Unassign
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {choices.length === 0 ? null : (
        <form className="assign-form" onSubmit={assign}>
          <label htmlFor="assign-identity" className="visually-hidden">
            Identity
          </label>
          <select id="assign-identity" value={chosen} onChange={(event: ChangeEvent<HTMLSelectElement>) => setChosen(event.target.value)}>
            <option value="">Choose an identity</option>
            {choices.map((handle) => (
              <option key={handle} value={handle}>
                {handle}
              </option>
            ))}
          </select>
          <button type="submit" className="button" disabled={sending || chosen === ""}>
            Assign
          </button>
        </form>
      )}
      {operation.problem === undefined ? null : (
        <p className="notice" role="alert">
          {operation.problem}
        </p>
      )}
    </section>
  );
}
