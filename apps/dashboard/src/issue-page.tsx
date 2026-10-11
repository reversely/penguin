// The issue page (PRD section 8): title, body, labels, assignees, the trigger, attached checks,
// sub-issues with their sessions and reviews, the timeline with rejected operations and their
// reasons, the comment box, and controls to assign an identity or unassign anyone. Every value from the issue renders as React text, so markup in an
// issue body or comment shows as text and runs nothing.
//
// The page shows no diff. Another owner's unfinished work appears only as linked commits and checks;
// the diff viewer, which shows the affected hunks only (open decision 2), is a later ticket.

import type {
  IssuePage,
  IssuePageAssignee,
  IssuePageCheck,
  IssuePageReview,
  IssuePageSubIssue,
  IssuePageTimelineEntry,
} from "@penguin/protocol";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import { fetchIssue, SignedOut, submitOperation } from "./api.ts";
import { EYE } from "./character.ts";
import {
  authorName,
  checkSignal,
  describeEntry,
  entrySignal,
  fixedIn,
  penguinState,
  reasonLabel,
  shortSha,
  SIGNAL_LABEL,
  STATE_LABEL,
  watchedIssues,
  type PenguinState,
  type Signal,
} from "./issue-view.ts";
import { latestChange } from "./live-changes.ts";
import { linkHandler } from "./links.ts";
import { assignChoices, assignOperation } from "./new-issue-view.ts";
import { useIdentityHandles, type IdentityHandles } from "./use-identity-handles.ts";
import type { Live } from "./use-live.ts";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: IssuePage }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

interface Props {
  readonly issueId: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export function IssuePageView({ issueId, live, navigate, onSignedOut }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const page = load.kind === "ready" && routeMatches(load.page, issueId) ? load.page : undefined;
  const change = latestChange(live, watchedIssues(page, issueId));
  const connected = live.status === "live";
  const identities = useIdentityHandles(live, onSignedOut);

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
  if (page === undefined) return <div className="issue" aria-busy="true" />;
  return (
    <IssueContent
      page={page}
      identities={identities}
      navigate={navigate}
      onSignedOut={onSignedOut}
      onWritten={() => setReload((value: number) => value + 1)}
    />
  );
}

function routeMatches(page: IssuePage, issueId: string): boolean {
  return page.issue.id === issueId || page.issue.alias === issueId;
}

function IssueContent({
  page,
  identities,
  navigate,
  onSignedOut,
  onWritten,
}: {
  page: IssuePage;
  identities: IdentityHandles;
  navigate: (path: string) => void;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const { issue } = page;
  const trigger = issue.commits.filter((commit) => commit.kind === "trigger");
  const otherCommits = issue.commits.filter((commit) => commit.kind !== "trigger");
  return (
    <article className="issue">
      <header className="issue-header">
        <h1>
          <span className="issue-number">#{issue.id}</span> {issue.title}
        </h1>
        <div className="issue-status">
          <span className={`tag state state-${issue.state}`}>{STATE_LABEL[issue.state]}</span>
          <PenguinIndicator state={penguinState(page)} />
          {issue.parentId === null ? null : (
            <a className="tag" href={`/issues/${issue.parentId}`} onClick={linkHandler(navigate, `/issues/${issue.parentId}`)}>
              Sub-issue of #{issue.parentId}
            </a>
          )}
        </div>
      </header>

      <div className="issue-layout">
        <div className="issue-main">
          <section className="panel" aria-labelledby="issue-body">
            <h2 id="issue-body" className="visually-hidden">
              Description
            </h2>
            {issue.body === "" ? <p className="muted">No description</p> : <p className="body-text">{issue.body}</p>}
          </section>

          <section className="panel" aria-labelledby="issue-checks">
            <h2 id="issue-checks">Checks</h2>
            {issue.checks.length === 0 ? (
              <p className="muted">No checks yet</p>
            ) : (
              <ul className="rows">
                {issue.checks.map((check) => (
                  <CheckRow key={check.opId} check={check} fixedIn={fixedIn(check, page.subIssues)} navigate={navigate} />
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="issue-sub-issues">
            <h2 id="issue-sub-issues">Sub-issues</h2>
            {page.subIssues.length === 0 ? (
              <p className="muted">No sub-issues</p>
            ) : (
              <ul className="rows">
                {page.subIssues.map((sub) => (
                  <SubIssueRow key={sub.id} sub={sub} navigate={navigate} />
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="issue-timeline">
            <h2 id="issue-timeline">Timeline</h2>
            <ol className="timeline">
              {page.timeline.map((entry) => (
                <TimelineRow key={entry.opId} entry={entry} />
              ))}
            </ol>
            <CommentBox issue={issue} onSignedOut={onSignedOut} onWritten={onWritten} />
          </section>
        </div>

        <aside className="issue-side">
          <section className="panel" aria-labelledby="issue-labels">
            <h2 id="issue-labels">Labels</h2>
            {issue.labels.length === 0 ? (
              <p className="muted">No labels</p>
            ) : (
              <ul className="tags">
                {issue.labels.map((label) => (
                  <li key={label} className="tag">
                    {label}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AssigneesPanel issue={issue} identities={identities} onSignedOut={onSignedOut} onWritten={onWritten} />

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
                    {commit.kind === null ? null : <span className="tag">{commit.kind}</span>}
                    <code className="revision">
                      {commit.repo}@{shortSha(commit.sha)}
                    </code>
                    <span className="muted">{authorName(commit.linkedBy)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </article>
  );
}

export function SignalTag({ signal, children }: { signal: Signal; children?: string }) {
  return <span className={`tag signal signal-${signal}`}>{children ?? SIGNAL_LABEL[signal]}</span>;
}

export function PenguinIndicator({ state }: { state: PenguinState }) {
  const slug = state.replaceAll(" ", "-");
  return (
    <span className={`penguin penguin-${slug}`} role="status">
      <PenguinMark />
      <span>Penguin {state}</span>
    </span>
  );
}

/** Penguin's own mark in the character style: a flat body with flippers, a two-lobed face, the
    characters' eye ovals and a beak, with no outline. */
function PenguinMark() {
  return (
    <svg className="penguin-mark" viewBox="0 0 40 40" focusable="false" aria-hidden="true">
      <path className="penguin-body" d={PENGUIN_BODY} />
      <path className="penguin-face" d={PENGUIN_FACE} />
      <ellipse className="penguin-eye" cx="16" cy="16" rx={EYE.rx} ry={EYE.ry} />
      <ellipse className="penguin-eye" cx="24" cy="16" rx={EYE.rx} ry={EYE.ry} />
      <path className="penguin-beak" d={PENGUIN_BEAK} />
    </svg>
  );
}

const PENGUIN_BODY =
  "M20 2.5C28 2.5 33 10 33.5 19C37 24 37.5 30 35 33C32 37 26 38 20 38C14 38 8 37 5 33C2.5 30 3 24 6.5 19C7 10 12 2.5 20 2.5Z";
const PENGUIN_FACE =
  "M20 13.2C21.3 9.8 24 8.6 26.4 9.6C29.6 11 30.2 15.6 28.4 19.6C30 24 29.6 30 26.6 33.4C24.8 35.4 22.4 36 20 36C17.6 36 15.2 35.4 13.4 33.4C10.4 30 10 24 11.6 19.6C9.8 15.6 10.4 11 13.6 9.6C16 8.6 18.7 9.8 20 13.2Z";
const PENGUIN_BEAK = "M18.2 22.2h3.6a.6.6 0 0 1 .5.9l-1.8 2.6a.6.6 0 0 1-1 0l-1.8-2.6a.6.6 0 0 1 .5-.9Z";

function CheckRow({
  check,
  fixedIn,
  navigate,
}: {
  check: IssuePageCheck;
  fixedIn: string | undefined;
  navigate: (path: string) => void;
}) {
  return (
    <li className={`row signal-row signal-row-${checkSignal(check)}`}>
      <SignalTag signal={checkSignal(check)} />
      <span className="row-title">{check.test ?? check.commandId}</span>
      <span className="tag" title="Command">
        {check.commandId}
      </span>
      <code className="revision" title="Revision">
        {check.repo}@{shortSha(check.sha)}
      </code>
      {check.logRef === null ? null : (
        <code className="muted" title="Log">
          {check.logRef}
        </code>
      )}
      {fixedIn === undefined ? null : (
        <a className="tag signal signal-verified" href={`/issues/${fixedIn}`} onClick={linkHandler(navigate, `/issues/${fixedIn}`)}>
          Fixed in #{fixedIn}
        </a>
      )}
    </li>
  );
}

function SubIssueRow({ sub, navigate }: { sub: IssuePageSubIssue; navigate: (path: string) => void }) {
  return (
    <li className="row sub-issue">
      <div className="sub-issue-head">
        <a className="row-title" href={`/issues/${sub.id}`} onClick={linkHandler(navigate, `/issues/${sub.id}`)}>
          #{sub.id} {sub.title}
        </a>
        <span className={`tag state state-${sub.state}`}>{STATE_LABEL[sub.state]}</span>
      </div>
      {sub.assignees.length === 0 ? null : (
        <ul className="rows nested">
          {sub.assignees.map((assignee) => (
            <li key={`${assignee.kind}:${assignee.id}`} className="row">
              <Assignee assignee={assignee} />
            </li>
          ))}
        </ul>
      )}
      {sub.reviews.length === 0 ? null : (
        <ul className="rows nested">
          {sub.reviews.map((review) => (
            <li key={review.opId} className="row">
              <ReviewTags review={review} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Assignee({ assignee, nameId }: { assignee: IssuePageAssignee; nameId?: string }) {
  return (
    <>
      <span className="row-title" id={nameId}>
        {assignee.id}
      </span>
      {assignee.session === null ? null : (
        <>
          <span className={`tag session-${assignee.session.status}`}>{assignee.session.status}</span>
          <span className="tag">{assignee.session.vendor}</span>
          <code className="muted">{assignee.session.branch}</code>
        </>
      )}
      {assignee.waitingFor === null ? null : (
        <span className="tag">{assignee.waitingFor === "acceptance" ? "Awaiting acceptance" : "Awaiting a session"}</span>
      )}
    </>
  );
}

function ReviewTags({ review }: { review: IssuePageReview }) {
  return (
    <>
      <SignalTag signal="review">{review.verdict === "approve" ? "Approved" : "Changes requested"}</SignalTag>
      <span className="row-title">{authorName(review.reviewer)}</span>
      {review.counts ? null : (
        <span className="tag" title={review.uncountedReason ?? undefined}>
          Not counted
        </span>
      )}
    </>
  );
}

function TimelineRow({ entry }: { entry: IssuePageTimelineEntry }) {
  const signal = entrySignal(entry);
  const { summary, text } = describeEntry(entry);
  const rejected = entry.status === "rejected";
  const review = entry.type === "review" ? (entry.payload as { verdict?: unknown } | null) : null;
  const classes = ["timeline-entry", signal === undefined ? "" : `signal-row signal-row-${signal}`, rejected ? "rejected" : ""];
  return (
    <li className={classes.filter((name) => name !== "").join(" ")}>
      <div className="timeline-head">
        <span className="timeline-author">{authorName(entry.author)}</span>
        <span className="timeline-summary">{summary}</span>
        <span className="timeline-tags">
          {signal === undefined ? null : (
            <SignalTag signal={signal}>
              {review === null ? undefined : review.verdict === "approve" ? "Approved" : "Changes requested"}
            </SignalTag>
          )}
          {rejected ? <span className="tag rejected-tag">Rejected</span> : null}
          {entry.waitingForGitLog ? <span className="tag waiting">Waiting for Git log</span> : null}
        </span>
      </div>
      {text === undefined ? null : <p className="body-text timeline-text">{text}</p>}
      {rejected ? (
        <p className="reject-reason">
          <span className="tag rejected-tag">{reasonLabel(entry.rejectReason)}</span>
          {entry.message === null ? null : <span className="muted">{entry.message}</span>}
        </p>
      ) : null}
    </li>
  );
}

/** The assignees, each with Unassign, and a choice of identity to assign. */
function AssigneesPanel({
  issue,
  identities,
  onSignedOut,
  onWritten,
}: {
  issue: IssuePage["issue"];
  identities: IdentityHandles;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const [chosen, setChosen] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const choices = identities.kind === "ready" ? assignChoices(identities.handles, issue.assignees) : [];

  const write = (type: "assign" | "unassign", assignee: Pick<IssuePageAssignee, "kind" | "id">) => {
    if (sending) return;
    setSending(true);
    setProblem(undefined);
    submitOperation(assignOperation(issue.id, issue.version, type, assignee)).then(
      (outcome) => {
        setSending(false);
        if (outcome.status === "applied") {
          if (type === "assign") setChosen("");
        } else {
          setProblem(`Rejected for ${reasonLabel(outcome.reason)}`);
        }
        onWritten();
      },
      (error: unknown) => {
        setSending(false);
        if (error instanceof SignedOut) onSignedOut();
        else setProblem("Please try again");
      },
    );
  };

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
                <Assignee assignee={assignee} nameId={`assignee-${key}`} />
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
          <select
            id="assign-identity"
            value={chosen}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setChosen(event.target.value)}
          >
            <option value="">Choose an identity</option>
            {choices.map((handle) => (
              <option key={handle} value={handle}>
                {handle}
              </option>
            ))}
          </select>
          <button type="submit" className="button primary" disabled={sending || chosen === ""}>
            Assign
          </button>
        </form>
      )}
      {problem === undefined ? null : (
        <p className="notice" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

function CommentBox({
  issue,
  onSignedOut,
  onWritten,
}: {
  issue: IssuePage["issue"];
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (body.trim() === "" || sending) return;
    setSending(true);
    setProblem(undefined);
    submitOperation({ issue: Number(issue.id), type: "comment", base_version: issue.version, payload: { body } }).then(
      (outcome) => {
        setSending(false);
        if (outcome.status === "applied") setBody("");
        else setProblem(`Rejected for ${reasonLabel(outcome.reason)}`);
        onWritten();
      },
      (error: unknown) => {
        setSending(false);
        if (error instanceof SignedOut) onSignedOut();
        else setProblem("Please try again");
      },
    );
  };

  return (
    <form className="comment-box" onSubmit={submit}>
      <label htmlFor="comment-body" className="visually-hidden">
        Comment
      </label>
      <textarea
        id="comment-body"
        rows={4}
        maxLength={32768}
        placeholder="Comment"
        value={body}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value)}
      />
      <div className="comment-actions">
        {problem === undefined ? null : (
          <p className="notice" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" className="button primary" disabled={sending || body.trim() === ""}>
          Comment
        </button>
      </div>
    </form>
  );
}
