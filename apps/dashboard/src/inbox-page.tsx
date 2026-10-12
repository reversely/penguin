// The inbox page holds the approvals that wait on the signed-in person (approvals.tsx, PRD 0.4
// section 10). The issue pages from before PRD 0.4 keep the person's issue items beside an open issue
// (PRD section 8; identity plan sections 4 and 5): five lists of rows, each opening its issue, with a
// dot that marks an unread item read. From 760px the rows sit in the shell's sidebar on an issue
// page; the inbox page and the rest of PRD 0.4's navigation carry no issue list. The shell reads the
// issue items again on every live change, so a new item shows without reload, and on an inbox-changed
// message, so marking an item read in one browser shows in the person's others. The board, read again
// on every live change, says what an item waits on the person for and which assignees run a session.
// Every value renders as React text, so markup in a title or a handle shows as text and runs nothing.

import type { InboxEntry, IssuePageState } from "@penguin/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchBoard, fetchInbox, markInboxRead, SignedOut } from "./api.ts";
import { IdentityAvatar } from "./avatar.tsx";
import { Icon } from "./icon.tsx";
import {
  boardFacts,
  CLOSED_WINDOW,
  groupInbox,
  INBOX_GROUPS,
  isOnline,
  itemKey,
  markedRead,
  newest,
  raisedLabel,
  WAITING_PREVIEW,
  waitingFor,
  type BoardFacts,
} from "./inbox-view.ts";
import { STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { useArrivals } from "./motion.tsx";
import { approvalCount, ApprovalsInbox, type ApprovalsState } from "./approvals.tsx";
import { issueAllPath, type Route } from "./routes.ts";
import { SidebarList } from "./sidebar-slot.tsx";
import type { Live } from "./use-live.ts";

export type InboxLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly InboxEntry[] }
  | { readonly kind: "failed" };

export interface InboxState {
  readonly load: InboxLoad;
  /** The keys of items being marked read. */
  readonly marking: ReadonlySet<string>;
  /** Whether the last attempt to mark an item read failed. */
  readonly markFailed: boolean;
  markRead(item: InboxEntry): void;
}

/** The signed-in person's inbox, read again on each live change and after a reconnect. */
export function useInbox(live: Live, onSignedOut: () => void): InboxState {
  const [load, setLoad] = useState<InboxLoad>({ kind: "loading" });
  const [marking, setMarking] = useState<ReadonlySet<string>>(new Set());
  const [markFailed, setMarkFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const connected = live.status === "live";

  useEffect(() => {
    let current = true;
    fetchInbox().then(
      (items) => {
        if (current) setLoad({ kind: "ready", items });
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        // A failed refresh keeps the inbox already shown.
        else if (current) setLoad((previous) => (previous.kind === "ready" ? previous : { kind: "failed" }));
      },
    );
    return () => {
      current = false;
    };
    // `connected` reads the inbox again after a reconnect, which may have missed a change.
  }, [live.revision, live.inboxRevision, connected, reloads, onSignedOut]);

  const markRead = useCallback(
    (item: InboxEntry) => {
      const key = itemKey(item);
      setMarkFailed(false);
      setMarking((previous) => new Set(previous).add(key));
      const done = () =>
        setMarking((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      markInboxRead(item).then(
        (found) => {
          done();
          // Shown at once; the live message reads the inbox again in the person's other browsers.
          if (found) setLoad((previous) => (previous.kind === "ready" ? { kind: "ready", items: markedRead(previous.items, key) } : previous));
          else setReloads((count) => count + 1);
        },
        (error: unknown) => {
          done();
          if (error instanceof SignedOut) onSignedOut();
          else setMarkFailed(true);
        },
      );
    },
    [onSignedOut],
  );

  return { load, marking, markFailed, markRead };
}

export type Read<T> = { readonly kind: "loading" } | { readonly kind: "ready"; readonly value: T } | { readonly kind: "failed" };

/** One API answer, read again whenever `revision` changes; a failed refresh keeps the last answer. */
export function useRead<T>(read: () => Promise<T>, revision: string, onSignedOut: () => void): Read<T> {
  const [state, setState] = useState<Read<T>>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    read().then(
      (value) => {
        if (current) setState({ kind: "ready", value });
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        else if (current) setState((previous) => (previous.kind === "ready" ? previous : { kind: "failed" }));
      },
    );
    return () => {
      current = false;
    };
  }, [read, revision, onSignedOut]);
  return state;
}

/**
 * The board's facts for the rows, read again on every live change (a session going online or
 * offline is one) and after a reconnect; undefined while loading. Without the board the rows still
 * show, with no assignee status and only the waits their reason states.
 */
function useBoardFacts(live: Live, onSignedOut: () => void): { readonly settled: boolean; readonly facts: BoardFacts | undefined } {
  const board = useRead(fetchBoard, `${live.revision}:${live.identitiesRevision}:${live.status === "live"}`, onSignedOut);
  const facts = useMemo(() => (board.kind === "ready" ? boardFacts(board.value) : undefined), [board]);
  return { settled: board.kind !== "loading", facts };
}

interface HostProps {
  readonly inbox: InboxState;
  readonly viewer: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

/** The issue rows in the shell's sidebar from 760px, beside an open issue. */
export function InboxSidebar({ route, ...props }: HostProps & { readonly route: Route | undefined }) {
  if (route?.page !== "issue") return null;
  // One element across issues, so opening a row keeps the list, its board and its scroll.
  return (
    <SidebarList>
      <SidebarInbox {...props} showAll={route.showAll} openIssue={route.issueId} />
    </SidebarList>
  );
}

function SidebarInbox({ inbox, viewer, live, showAll, openIssue, navigate, onSignedOut }: HostProps & ListOptions) {
  const { settled, facts } = useBoardFacts(live, onSignedOut);
  if (!settled) return <div className="inbox-list" aria-busy="true" />;
  return <InboxList inbox={inbox} facts={facts} viewer={viewer} now={new Date()} showAll={showAll} openIssue={openIssue} navigate={navigate} />;
}

interface PageProps {
  readonly approvals: ApprovalsState;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

/** The inbox page: the approvals that wait on the person, with the facts behind each. */
export function InboxPage({ approvals, navigate, onSignedOut }: PageProps) {
  if (!approvals.loaded) return <div className="inbox" aria-busy="true" />;
  const empty = approvalCount(approvals.approvals) === 0 && !approvals.failed;
  return (
    <div className="inbox">
      <header className="page-header">
        <h1>Inbox</h1>
      </header>
      <ApprovalsInbox state={approvals} navigate={navigate} onSignedOut={onSignedOut} />
      {empty ? <p className="inbox-empty">Please open the team view to follow running features</p> : null}
    </div>
  );
}

interface ListOptions {
  /** Whether the Closed issues list shows every item rather than the newest. */
  readonly showAll: boolean;
  /** The issue open beside the list, whose rows show selected. */
  readonly openIssue: string | undefined;
}

interface ListProps extends ListOptions {
  readonly inbox: InboxState;
  readonly facts: BoardFacts | undefined;
  readonly viewer: string;
  readonly now: Date;
  readonly navigate: (path: string) => void;
}

/** The five lists under their noun headings, with their counts. */
export function InboxList({ inbox, facts, viewer, now, showAll, openIssue, navigate }: ListProps) {
  const { load } = inbox;
  // Rows a live change adds slide in; Show all widens the list without motion.
  const arrival = useArrivals(load.kind === "ready" ? load.items.map(itemKey) : undefined, showAll ? "all" : "newest");
  if (load.kind === "loading") return <div className="inbox-list" aria-busy="true" />;
  if (load.kind === "failed") {
    return (
      <p className="notice inbox-list" role="alert">
        Please reload the page
      </p>
    );
  }
  const groups = groupInbox(load.items);
  // Show all keeps the open issue beside the longer list.
  const allPath = openIssue === undefined ? undefined : issueAllPath(openIssue);
  return (
    <nav className="inbox-list" aria-label="Inbox items">
      {inbox.markFailed ? (
        <p className="notice" role="alert">
          Please try marking it read again
        </p>
      ) : null}
      {INBOX_GROUPS.map((group) => {
        const items = groups[group.id];
        const shown = group.id === "closed" ? newest(items, CLOSED_WINDOW, showAll) : items;
        const headingId = `inbox-${group.id}`;
        return (
          <section key={group.id} className="inbox-group" aria-labelledby={headingId}>
            <h2 id={headingId} className="inbox-group-heading">
              {group.label} <span className="muted">{items.length}</span>
            </h2>
            {shown.length === 0 ? null : (
              <ol className="inbox-rows">
                {shown.map((item) => (
                  <InboxRow
                    key={itemKey(item)}
                    item={item}
                    facts={facts}
                    viewer={viewer}
                    now={now}
                    open={item.issueId === openIssue}
                    arrival={arrival(itemKey(item))}
                    marking={inbox.marking.has(itemKey(item))}
                    onMarkRead={inbox.markRead}
                    navigate={navigate}
                  />
                ))}
              </ol>
            )}
            {shown.length < items.length && allPath !== undefined ? (
              <a className="show-all" href={allPath} aria-describedby={headingId} onClick={linkHandler(navigate, allPath)}>
                Show all
                <Icon name="chevron" />
              </a>
            ) : null}
          </section>
        );
      })}
    </nav>
  );
}

interface RowProps {
  readonly item: InboxEntry;
  readonly facts: BoardFacts | undefined;
  readonly viewer: string;
  readonly now: Date;
  readonly open: boolean;
  /** The row's stagger index when a live change just added it. */
  readonly arrival: string | undefined;
  readonly marking: boolean;
  readonly onMarkRead: (item: InboxEntry) => void;
  readonly navigate: (path: string) => void;
}

const RAISED_FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * One item as a sidebar row (identity plan section 5): the first assignee's character, the issue
 * title, then the issue number, the state or what the item waits on the person for and the raised
 * time. The dot at the right is the Mark read control on an unread item; it takes the attention
 * colour while the item waits on the person, whose preview then says so in words.
 */
function InboxRow({ item, facts, viewer, now, open, arrival, marking, onMarkRead, navigate }: RowProps) {
  const path = `/issues/${item.issueId}`;
  const titleId = `inbox-item-${itemKey(item)}`;
  const numberId = `${titleId}-number`;
  const waiting = waitingFor(item, facts?.issues.get(item.issueId), viewer);
  const handle = item.assigneeHandles[0];
  const identity = handle === undefined ? undefined : facts?.identities.get(handle);
  const online = isOnline(identity);
  const raisedTime = Date.parse(item.raisedAt);
  return (
    <li className="inbox-row" data-waiting={waiting === null ? undefined : true} data-arrival={arrival}>
      <a className="inbox-row-link" href={path} aria-current={open ? "page" : undefined} onClick={linkHandler(navigate, path)}>
        <span className="avatar-slot">
          {handle === undefined ? (
            <StateGlyph state={item.state} />
          ) : (
            <IdentityAvatar handle={handle} image={identity?.avatar ?? null} size="row" />
          )}
          {online ? <span className="dot dot-online" /> : null}
        </span>
        {/* The title has the first line to itself; the number, the state or wait and the time share
            the second, so a sidebar row shows enough of the title to tell the issue. */}
        <span className="inbox-row-text">
          <span id={titleId} className="inbox-row-title">
            {item.title}
          </span>
          <span className="inbox-row-meta">
            <span className="inbox-row-preview">
              <span id={numberId} className="issue-number">
                #{item.issueId}
              </span>{" "}
              {waiting === null ? (STATE_LABEL[item.state] ?? item.state) : WAITING_PREVIEW[waiting]}
            </span>
            <time dateTime={item.raisedAt} title={Number.isNaN(raisedTime) ? undefined : RAISED_FULL.format(raisedTime)}>
              {raisedLabel(item.raisedAt, now)}
            </time>
          </span>
        </span>
        {/* The character and the dots are drawn, so their meaning is also given as text. */}
        {handle === undefined ? null : <span className="visually-hidden">{online ? `${handle} online` : handle}</span>}
        {item.read ? null : <span className="visually-hidden">Unread</span>}
      </a>
      {item.read ? (
        waiting === null ? null : <span className="inbox-row-dot dot dot-attention" aria-hidden="true" />
      ) : (
        <button
          type="button"
          className="inbox-row-mark"
          title="Mark read"
          aria-label="Mark read"
          aria-describedby={`${numberId} ${titleId}`}
          disabled={marking}
          onClick={() => onMarkRead(item)}
        >
          <span className={waiting === null ? "dot dot-unread" : "dot dot-attention"} />
          <Icon name="check" />
        </button>
      )}
    </li>
  );
}

/** The avatar slot of an issue no identity is assigned to: a neutral glyph of its state. */
function StateGlyph({ state }: { state: IssuePageState }) {
  return (
    <span className="avatar avatar-row inbox-row-glyph" aria-hidden="true">
      <Icon name={state === "closed" ? "check" : "clock"} />
    </span>
  );
}
