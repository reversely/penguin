// The issue's activity (identity plan section 5, Thread entries): every post on the issue by a person,
// an agent identity or Penguin, in apply order. Each comment shows its author's byline above it, the
// viewer's own in ink; Penguin's alerts are centred system lines; claims and other operations are
// compact lines; checks are evidence cards; reviews are approval cards; threads are cards with their
// replies; rejected operations are struck through with their reasons. Above them, "Needs you" links to
// each thread and fix that waits for the viewer. Each fix's approval card and the composer, which
// comments on the issue, follow. An agent's name links to its agent card. Agent sessions are private
// to their owners, so the page shows only what is posted on the issue. Every value renders as React
// text.

import type { IssuePage, IssuePageThread, IssuePageTimelineEntry } from "@penguin/protocol";
import { useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { submitOperation, type WriteOutcome } from "./api.ts";
import { CheckCard, FixApprovalCard, ReviewCard } from "./issue-cards.tsx";
import { AuthorAvatar, AuthorName, Byline, PenguinMark, type Authors } from "./issue-marks.tsx";
import { Icon } from "./icon.tsx";
import { WAITING_PREVIEW } from "./inbox-view.ts";
import {
  approvalFixes,
  authorName,
  composerRows,
  describeEntry,
  entryIds,
  entryKind,
  fixAnchor,
  fixedIn,
  needsYou,
  reasonLabel,
  threadAnchor,
  threadEntries,
  threadOpener,
  type EntryKind,
  type NeedsYouItem,
} from "./issue-view.ts";
import { useArrivals, type Arrival } from "./motion.tsx";
import { useOperation } from "./use-operation.ts";

interface ThreadProps {
  readonly page: IssuePage;
  readonly viewer: string;
  readonly authors: Authors;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
  readonly onWritten: () => void;
}

export function IssueThread(props: ThreadProps) {
  const { page, viewer } = props;
  const fixes = approvalFixes(page.subIssues);
  const ids = entryIds(page.issue);
  const replies = threadEntries(page.timeline);
  // Posts, replies and approval cards a live change adds slide in, staggered when several arrive.
  const arrival = useArrivals([...page.timeline.map((entry) => entry.opId), ...fixes.map((fix) => `fix:${fix.id}`)]);
  return (
    <section className="thread-pane" aria-labelledby="issue-thread">
      <h2 id="issue-thread" className="visually-hidden">
        Activity
      </h2>
      <NeedsYou items={needsYou(page, viewer)} />
      <ol className="thread">
        {page.timeline.map((entry) => {
          const kind = entryKind(entry, viewer, ids);
          return kind === "in-thread" ? null : (
            <ThreadEntry key={entry.opId} entry={entry} kind={kind} replies={replies} arrival={arrival} {...props} />
          );
        })}
      </ol>
      {fixes.length === 0 ? null : (
        <section className="approvals" aria-labelledby="issue-reviews">
          <h2 id="issue-reviews" className="visually-hidden">
            Reviews
          </h2>
          <ul className="thread">
            {fixes.map((fix) => (
              <li key={fix.id} id={fixAnchor(fix.id)} tabIndex={-1} className="entry entry-card" data-arrival={arrival(`fix:${fix.id}`)}>
                <FixApprovalCard
                  fix={fix}
                  viewer={viewer}
                  authors={props.authors}
                  navigate={props.navigate}
                  onSignedOut={props.onSignedOut}
                  onWritten={props.onWritten}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <CommentComposer issue={page.issue} onSignedOut={props.onSignedOut} onWritten={props.onWritten} />
    </section>
  );
}

/**
 * What waits for the viewer, above the activity: each open thread that needs them and each fix
 * waiting for their review, linking to its card. The activity keeps its order below.
 */
function NeedsYou({ items }: { items: readonly NeedsYouItem[] }) {
  const key = (item: NeedsYouItem) => (item.kind === "thread" ? `thread:${item.thread.id}` : `fix:${item.fix.id}`);
  const arrival = useArrivals(items.map(key));
  if (items.length === 0) return null;
  return (
    <section className="card-raised needs-you" aria-labelledby="issue-needs-you">
      <h2 id="issue-needs-you" className="needs-you-heading">
        Needs you
      </h2>
      <ul className="needs-you-list">
        {items.map((item) =>
          item.kind === "thread" ? (
            <li key={key(item)} data-arrival={arrival(key(item))}>
              <CardLink target={threadAnchor(item.thread.id)}>
                <span className="needs-you-title">Thread from {authorName(item.opener)}</span>
                <span className="tag approval-status approval-attention">{WAITING_PREVIEW.reply}</span>
              </CardLink>
            </li>
          ) : (
            <li key={key(item)} data-arrival={arrival(key(item))}>
              <CardLink target={fixAnchor(item.fix.id)}>
                <span className="needs-you-title">
                  <span className="issue-number">#{item.fix.id}</span> {item.fix.title}
                </span>
                <span className="tag approval-status approval-attention">{WAITING_PREVIEW.review}</span>
              </CardLink>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/**
 * A link to a card on the page. A plain press scrolls the card into view and moves focus to it, so
 * the keyboard continues from the card; a modified press opens the page at the card the browser's way.
 */
function CardLink({ target, children }: { target: string; children: ReactNode }) {
  const jump = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const card = document.getElementById(target);
    if (card === null) return;
    event.preventDefault();
    card.scrollIntoView({ block: "start" });
    card.focus({ preventScroll: true });
  };
  return (
    <a className="needs-you-link" href={`#${target}`} onClick={jump}>
      {children}
    </a>
  );
}

function ThreadEntry({
  entry,
  kind,
  replies,
  arrival,
  page,
  authors,
  navigate,
  onSignedOut,
  onWritten,
}: ThreadProps & {
  entry: IssuePageTimelineEntry;
  kind: EntryKind;
  replies: ReadonlyMap<string, readonly IssuePageTimelineEntry[]>;
  arrival: Arrival;
}) {
  const { issue } = page;
  const { summary, text } = describeEntry(entry);
  switch (kind) {
    case "opened":
      return (
        <li className="entry entry-comment" data-arrival={arrival(entry.opId)}>
          <Byline segment={entry.author} authors={authors}>
            <span className="byline-meta">opened the issue</span>
          </Byline>
          {issue.body === "" ? <p className="entry-meta entry-indent">No description</p> : <p className="bubble">{issue.body}</p>}
        </li>
      );
    case "comment":
    case "own-comment":
      return (
        <li className="entry entry-comment" data-arrival={arrival(entry.opId)}>
          <Byline segment={entry.author} authors={authors}>
            {entry.type === "edit_comment" ? <span className="byline-meta">{summary}</span> : null}
          </Byline>
          {text === undefined ? null : <p className={kind === "own-comment" ? "bubble bubble-own" : "bubble"}>{text}</p>}
        </li>
      );
    case "system":
      return (
        <li className="entry entry-system" data-arrival={arrival(entry.opId)}>
          <p className="system-line">
            <PenguinMark className="system-mark" />
            <span>
              {authorName(entry.author)} {summary}
            </span>
          </p>
          {text === undefined ? null : <p className="system-text">{text}</p>}
        </li>
      );
    case "check": {
      const check = issue.checks.find((candidate) => candidate.opId === entry.opId)!;
      return (
        <li className="entry entry-card" data-arrival={arrival(entry.opId)}>
          <CheckCard check={check} author={entry.author} fixedIn={fixedIn(check, page.subIssues)} authors={authors} navigate={navigate} />
        </li>
      );
    }
    case "review": {
      const review = issue.reviews.find((candidate) => candidate.opId === entry.opId)!;
      return (
        <li className="entry entry-card" data-arrival={arrival(entry.opId)}>
          <ReviewCard review={review} authors={authors} />
        </li>
      );
    }
    case "thread": {
      const thread = issue.threads.find((candidate) => candidate.id === entry.opId)!;
      return (
        <li className="entry entry-card" data-arrival={arrival(entry.opId)}>
          <ThreadCard
            page={page}
            thread={thread}
            replies={replies.get(thread.id) ?? []}
            arrival={arrival}
            authors={authors}
            onSignedOut={onSignedOut}
            onWritten={onWritten}
          />
        </li>
      );
    }
    case "rejected":
      return (
        <li className="entry entry-rejected" data-arrival={arrival(entry.opId)}>
          <p className="event-line">
            <AuthorName segment={entry.author} authors={authors} className="event-author" />
            <s className="event-summary">{summary}</s>
            <span className="tag rejected-tag">Rejected</span>
            <span className="tag rejected-tag">{reasonLabel(entry.rejectReason)}</span>
          </p>
          {entry.message === null ? null : <p className="event-text">{entry.message}</p>}
          {text === undefined ? null : <p className="event-text event-quote">{text}</p>}
        </li>
      );
    case "claim":
    case "event":
    case "in-thread":
      return (
        <li className={`entry entry-${kind === "claim" ? "claim" : "event"}`} data-arrival={arrival(entry.opId)}>
          <p className="event-line">
            {kind === "claim" ? <AuthorAvatar segment={entry.author} authors={authors} /> : null}
            <AuthorName segment={entry.author} authors={authors} className="event-author" />
            <span className="event-summary">{summary}</span>
            {kind === "claim" ? <span className="tag signal signal-claim">Claim</span> : null}
          </p>
          {text === undefined ? null : <p className="event-text">{text}</p>}
        </li>
      );
  }
}

/**
 * One thread as a card: who it speaks for, whom it needs, its text, its replies and, while open, a
 * reply composer and Resolve. Only people resolve a thread; the dashboard's viewer is always a
 * person, and agents reply through MCP.
 */
function ThreadCard({
  page,
  thread,
  replies,
  arrival,
  authors,
  onSignedOut,
  onWritten,
}: {
  page: IssuePage;
  thread: IssuePageThread;
  arrival: Arrival;
  replies: readonly IssuePageTimelineEntry[];
  authors: Authors;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const { issue } = page;
  const open = thread.status === "open";
  const operation = useOperation(onSignedOut, onWritten);
  const answers = replies.filter((reply) => reply.type === "reply_thread");
  const resolve = () =>
    operation.send("resolve", () =>
      submitOperation({ issue: Number(issue.id), type: "resolve_thread", base_version: issue.version, payload: { thread: thread.id } }),
    );
  return (
    <article id={threadAnchor(thread.id)} tabIndex={-1} className="card-raised thread-card" data-open={open || undefined}>
      <div className="thread-card-head">
        <Byline segment={threadOpener(thread, issue.reviews)} authors={authors} />
        <span className={`tag thread-status thread-${thread.status}`}>{open ? "Open" : "Resolved"}</span>
      </div>
      {thread.needsPersonIds.length === 0 ? null : (
        <p className="thread-needs">Needs {thread.needsPersonIds.map(authorName).join(", ")}</p>
      )}
      <p className="thread-body">{thread.body}</p>
      {answers.length === 0 ? null : (
        <ol className="thread-replies">
          {answers.map((reply) => (
            <li key={reply.opId} className="thread-reply" data-arrival={arrival(reply.opId)}>
              <Byline segment={reply.author} authors={authors} />
              {describeEntry(reply).text === undefined ? null : <p className="thread-reply-text">{describeEntry(reply).text}</p>}
            </li>
          ))}
        </ol>
      )}
      {thread.resolvedBy === null ? null : (
        <div className="thread-resolution">
          <p className="thread-needs">Resolved by {authorName(thread.resolvedBy)}</p>
          {thread.resolveReason === null ? null : <p className="approval-quote">{thread.resolveReason}</p>}
        </div>
      )}
      {open ? (
        <div className="thread-card-actions">
          <Composer
            id={`thread-reply-${thread.id}`}
            label="Reply"
            maxLength={32768}
            write={(body) =>
              submitOperation({ issue: Number(issue.id), type: "reply_thread", base_version: issue.version, payload: { thread: thread.id, body } })
            }
            onSignedOut={onSignedOut}
            onWritten={onWritten}
          />
          <div className="thread-resolve">
            {operation.problem === undefined ? null : (
              <p className="notice" role="alert">
                {operation.problem}
              </p>
            )}
            <button type="button" className="button progressive" disabled={operation.sending !== undefined} onClick={resolve}>
              {operation.sending === "resolve" ? "Resolving" : "Resolve"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function CommentComposer({ issue, onSignedOut, onWritten }: { issue: IssuePage["issue"]; onSignedOut: () => void; onWritten: () => void }) {
  return (
    <Composer
      id="comment-body"
      label="Comment"
      maxLength={32768}
      write={(body) => submitOperation({ issue: Number(issue.id), type: "comment", base_version: issue.version, payload: { body } })}
      onSignedOut={onSignedOut}
      onWritten={onWritten}
    />
  );
}

/**
 * The composer (identity plan section 5): a pill whose field grows to six lines, a visually hidden
 * label and a round send button named by the same label. Cmd or Ctrl and Enter sends.
 */
function Composer({
  id,
  label,
  maxLength,
  write,
  onSignedOut,
  onWritten,
}: {
  id: string;
  label: string;
  maxLength: number;
  write: (body: string) => Promise<WriteOutcome>;
  onSignedOut: () => void;
  onWritten: () => void;
}) {
  const [body, setBody] = useState("");
  const operation = useOperation(onSignedOut, onWritten);
  const empty = body.trim() === "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!empty) operation.send("send", () => write(body), () => setBody(""));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-pill">
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
        <textarea
          id={id}
          rows={composerRows(body)}
          maxLength={maxLength}
          placeholder={label}
          value={body}
          onKeyDown={onKeyDown}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value)}
        />
        <button type="submit" className="composer-send" aria-label={label} disabled={operation.sending !== undefined || empty}>
          <Icon name="send" />
        </button>
      </div>
      {operation.problem === undefined ? null : (
        <p className="notice" role="alert">
          {operation.problem}
        </p>
      )}
    </form>
  );
}
