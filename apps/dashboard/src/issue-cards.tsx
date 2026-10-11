// The issue thread's cards (identity plan section 5). An evidence card shows one check: its signal
// and tags, who attached it, the test, where it ran and, when a sub-issue's passing check covers a
// failure, the fix. An approval card shows a fix sub-issue's review: its status, the owners whose
// review counts and, while the viewer's review is pending, Approve and Request changes. A settled
// approval card shows a review recorded on the issue itself. Each card renders only the parts its
// data has. Both are compound components, so a page composes the parts it needs.

import type { IssuePageCheck, IssuePageReview } from "@penguin/protocol";
import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { fetchIssue, submitOperation } from "./api.ts";
import { PersonAvatar } from "./avatar.tsx";
import { Byline, SignalTag, type Authors } from "./issue-marks.tsx";
import {
  APPROVAL_LABEL,
  APPROVAL_STATUS_LABEL,
  approvalStatus,
  assigneeSegment,
  authorName,
  checkSignal,
  reviewSuperseded,
  shortCommit,
  shortSha,
  STATE_LABEL,
  type ApprovalFix,
  type ApprovalStatus,
  type Signal,
} from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { useOperation } from "./use-operation.ts";

/* Evidence card */

function EvidenceRoot({ signal, superseded, children }: { signal: Signal; superseded: boolean; children: ReactNode }) {
  return (
    <article className={`card-raised evidence evidence-${signal}`} data-superseded={superseded || undefined}>
      {children}
    </article>
  );
}

function EvidenceHeader({ children }: { children: ReactNode }) {
  return <div className="evidence-header">{children}</div>;
}

function EvidenceTitle({ children }: { children: ReactNode }) {
  return <h3 className="evidence-title">{children}</h3>;
}

function EvidenceBody({ children }: { children: ReactNode }) {
  return <div className="evidence-body">{children}</div>;
}

function EvidenceFooter({ children }: { children: ReactNode }) {
  return <div className="evidence-footer">{children}</div>;
}

export const EvidenceCard = {
  Root: EvidenceRoot,
  Header: EvidenceHeader,
  Byline,
  Title: EvidenceTitle,
  Body: EvidenceBody,
  Footer: EvidenceFooter,
};

/** One check as an evidence card. `author` is the author segment of the operation that attached it. */
export function CheckCard({
  check,
  author,
  fixedIn,
  authors,
  navigate,
}: {
  check: IssuePageCheck;
  author: string | null;
  fixedIn: string | undefined;
  authors: Authors;
  navigate: (path: string) => void;
}) {
  const signal = checkSignal(check);
  const superseded = check.supersededBy !== null;
  return (
    <EvidenceCard.Root signal={signal} superseded={superseded}>
      <EvidenceCard.Header>
        <SignalTag signal={signal} />
        <span className="tag tag-data" title="Command">
          {check.commandId}
        </span>
        <span className="tag tag-data tag-mono" title="Revision">
          {shortSha(check.sha)}
        </span>
        {superseded ? (
          <span className="tag tag-data tag-superseded" title="A newer checkpoint replaced this result">
            Superseded
          </span>
        ) : null}
      </EvidenceCard.Header>
      <EvidenceCard.Byline segment={author} authors={authors} />
      <EvidenceCard.Title>{check.test ?? check.commandId}</EvidenceCard.Title>
      <EvidenceCard.Body>
        <code title="Revision">
          {check.repo}@{shortSha(check.sha)}
        </code>
        {check.logRef === null ? null : <code title="Log">{check.logRef}</code>}
      </EvidenceCard.Body>
      {fixedIn === undefined ? null : (
        <EvidenceCard.Footer>
          <a className="tag signal signal-verified" href={`/issues/${fixedIn}`} onClick={linkHandler(navigate, `/issues/${fixedIn}`)}>
            Fixed in #{fixedIn}
          </a>
        </EvidenceCard.Footer>
      )}
    </EvidenceCard.Root>
  );
}

/* Approval card */

type Tone = "attention" | "verified" | "review" | "neutral";

const STATUS_TONE: Readonly<Record<ApprovalStatus, Tone>> = {
  "waiting-for-you": "attention",
  approved: "verified",
  "changes-requested": "review",
  waiting: "neutral",
};

function ApprovalRoot({ waiting, children }: { waiting: boolean; children: ReactNode }) {
  return (
    <article className="card-raised approval" data-waiting={waiting || undefined}>
      {children}
    </article>
  );
}

function ApprovalHeader({ children }: { children: ReactNode }) {
  return <div className="approval-header">{children}</div>;
}

function ApprovalTitle({ children }: { children: ReactNode }) {
  return <h3 className="approval-title">{children}</h3>;
}

function ApprovalStatusChip({ tone, title, children }: { tone: Tone; title?: string; children: string }) {
  return (
    <span className={`tag approval-status approval-${tone}`} title={title}>
      {children}
    </span>
  );
}

function ApprovalBody({ children }: { children: ReactNode }) {
  return <div className="approval-body">{children}</div>;
}

function ApprovalQuote({ children }: { children: string }) {
  return <blockquote className="approval-quote">{children}</blockquote>;
}

function ApprovalActions({ children }: { children: ReactNode }) {
  return <div className="approval-actions">{children}</div>;
}

export const ApprovalCard = {
  Root: ApprovalRoot,
  Header: ApprovalHeader,
  Title: ApprovalTitle,
  Status: ApprovalStatusChip,
  Body: ApprovalBody,
  Quote: ApprovalQuote,
  Actions: ApprovalActions,
};

/** A review recorded on the issue itself, as a settled approval card. */
export function ReviewCard({ review, authors }: { review: IssuePageReview; authors: Authors }) {
  const approved = review.verdict === "approve";
  return (
    <ApprovalCard.Root waiting={false}>
      <ApprovalCard.Header>
        <Byline segment={review.reviewer} authors={authors} />
        {review.counts ? (
          <ApprovalCard.Status tone={approved ? "verified" : "review"}>{approved ? "Approved" : "Changes requested"}</ApprovalCard.Status>
        ) : (
          <ApprovalCard.Status tone="neutral" title={review.uncountedReason ?? undefined}>
            Not counted
          </ApprovalCard.Status>
        )}
      </ApprovalCard.Header>
      <ApprovalCard.Body>
        <p className="approval-line">
          <span>{approved ? "Approved" : "Requested changes on"}</span>
          <code>
            {review.repo}@{shortSha(review.sha)}
          </code>
        </p>
        {review.counts || review.uncountedReason === null ? null : <p className="approval-note">{review.uncountedReason}</p>}
        {review.reason === null ? null : <ApprovalCard.Quote>{review.reason}</ApprovalCard.Quote>}
      </ApprovalCard.Body>
    </ApprovalCard.Root>
  );
}

/**
 * A fix sub-issue's approval card: its title and status, the fixing identity, the head under review,
 * each owner whose review counts and every review that does not. While the viewer's review is pending
 * it carries the page's one ink primary, Approve, and Request changes.
 */
export function FixApprovalCard({
  fix,
  viewer,
  authors,
  navigate,
  onSignedOut,
  onWritten,
}: {
  fix: ApprovalFix;
  viewer: string;
  authors: Authors;
  navigate: (path: string) => void;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const { approval } = fix;
  const status = approvalStatus(approval, viewer);
  const fixer = fix.assignees.find((assignee) => assignee.kind === "identity");
  const titleId = `approval-${fix.id}`;
  const others = fix.reviews.filter((review) => !review.counts || reviewSuperseded(review, approval));
  return (
    <ApprovalCard.Root waiting={status === "waiting-for-you"}>
      <ApprovalCard.Header>
        <ApprovalCard.Title>
          <a id={titleId} href={`/issues/${fix.id}`} onClick={linkHandler(navigate, `/issues/${fix.id}`)}>
            <span className="issue-number">#{fix.id}</span> {fix.title}
          </a>
        </ApprovalCard.Title>
        <ApprovalCard.Status tone={STATUS_TONE[status]}>{APPROVAL_STATUS_LABEL[status]}</ApprovalCard.Status>
      </ApprovalCard.Header>
      <ApprovalCard.Body>
        <p className="approval-line">
          {fixer === undefined ? null : <Byline segment={assigneeSegment(fixer)} authors={authors} />}
          <span className={`tag state state-${fix.state}`}>{STATE_LABEL[fix.state]}</span>
          {approval.head === null ? null : <code title="Fix commit">{shortCommit(approval.head)}</code>}
        </p>
        {approval.owners.length === 0 ? null : (
          <ul className="approval-owners">
            {approval.owners.map((owner) => (
              <li key={owner.owner}>
                <div className="approval-owner">
                  <PersonAvatar id={owner.owner} size="card" />
                  <span className="byline-name">{authorName(owner.owner)}</span>
                  <span className={`tag approval-owner-state owner-${owner.state}`}>{APPROVAL_LABEL[owner.state]}</span>
                  {owner.reviewer === null || owner.reviewer === owner.owner ? null : (
                    <span className="muted">by delegate {authorName(owner.reviewer)}</span>
                  )}
                </div>
                {owner.state === "changes_requested" && owner.reason !== null ? <ApprovalCard.Quote>{owner.reason}</ApprovalCard.Quote> : null}
              </li>
            ))}
          </ul>
        )}
        {others.length === 0 ? null : (
          <ul className="approval-owners">
            {others.map((review) => (
              <li key={review.opId}>
                <div className="approval-owner">
                  <PersonAvatar id={review.reviewer} size="card" />
                  <span className="byline-name">{authorName(review.reviewer)}</span>
                  <span className={`tag approval-owner-state owner-${review.verdict === "approve" ? "approved" : "changes_requested"}`}>
                    {review.verdict === "approve" ? "Approved" : "Changes requested"}
                  </span>
                  {review.counts ? (
                    <span className="tag tag-data" title={`Reviewed ${review.repo}@${shortSha(review.sha)}, an older commit than the fix's head`}>
                      Older commit
                    </span>
                  ) : (
                    <span className="tag tag-data" title={review.uncountedReason ?? undefined}>
                      Not counted
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ApprovalCard.Body>
      {status === "waiting-for-you" && approval.head !== null ? (
        <ReviewActions fixId={fix.id} head={approval.head} titleId={titleId} onSignedOut={onSignedOut} onWritten={onWritten} />
      ) : null}
    </ApprovalCard.Root>
  );
}

/**
 * Approve and Request changes on a fix's head. A request for changes asks for a reason first (PRD
 * section 8). The review is written to the fix sub-issue at its current version, read just before.
 */
function ReviewActions({
  fixId,
  head,
  titleId,
  onSignedOut,
  onWritten,
}: {
  fixId: string;
  head: string;
  titleId: string;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const [writing, setWriting] = useState(false);
  const [reason, setReason] = useState("");
  const operation = useOperation(onSignedOut, onWritten);
  const requestRef = useRef<HTMLButtonElement | null>(null);
  const busy = operation.sending !== undefined;

  const review = (verdict: "approve" | "request_changes") =>
    operation.send(
      verdict,
      async () => {
        const fix = await fetchIssue(fixId);
        if (fix === undefined) throw new Error(`issue ${fixId} is missing`);
        const payload = verdict === "approve" ? { verdict, commit: head } : { verdict, commit: head, reason: reason.trim() };
        return submitOperation({ issue: Number(fixId), type: "review", base_version: fix.issue.version, payload });
      },
      () => {
        setWriting(false);
        setReason("");
        // The actions leave once the review applies, so focus moves to the card's title.
        requestAnimationFrame(() => document.getElementById(titleId)?.focus());
      },
    );

  const cancel = () => {
    setWriting(false);
    setReason("");
    requestAnimationFrame(() => requestRef.current?.focus());
  };
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim() !== "") review("request_changes");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !busy) cancel();
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const reasonId = `review-reason-${fixId}`;
  return (
    <>
      {writing ? (
        <form className="approval-reason" onSubmit={send} aria-labelledby={titleId}>
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            id={reasonId}
            rows={3}
            maxLength={4096}
            value={reason}
            autoFocus
            readOnly={busy}
            onKeyDown={onKeyDown}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
          />
          {/* While a review sends, the controls keep focus and refuse presses through aria-disabled. */}
          <ApprovalCard.Actions>
            <button type="submit" className="button primary progressive" aria-disabled={busy || reason.trim() === ""}>
              {operation.sending === "request_changes" ? "Sending" : "Send"}
            </button>
            <button type="button" className="button quiet" aria-disabled={busy} onClick={() => busy || cancel()}>
              Cancel
            </button>
          </ApprovalCard.Actions>
        </form>
      ) : (
        <ApprovalCard.Actions>
          <button
            type="button"
            className="button primary progressive"
            aria-disabled={busy}
            aria-describedby={titleId}
            onClick={() => review("approve")}
          >
            {operation.sending === "approve" ? "Approving" : "Approve"}
          </button>
          <button
            ref={requestRef}
            type="button"
            className="button"
            aria-disabled={busy}
            aria-describedby={titleId}
            onClick={() => busy || setWriting(true)}
          >
            Request changes
          </button>
        </ApprovalCard.Actions>
      )}
      {operation.problem === undefined ? null : (
        <p className="notice" role="alert">
          {operation.problem}
        </p>
      )}
    </>
  );
}
