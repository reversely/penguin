// The inbox (PRD section 8): the signed-in person's items in five lists, each linking to its issue
// page, with a button that marks an unread item read. The shell reads the inbox again on every live
// change, so a new item shows without reload. It also reads it again on an inbox-changed message, so
// marking an item read in one browser shows in the person's others. Every value renders as React text,
// so markup in a title shows as text and runs nothing.

import type { InboxEntry } from "@penguin/protocol";
import { useCallback, useEffect, useState } from "react";

import { fetchInbox, markInboxRead, SignedOut } from "./api.ts";
import { CLOSED_WINDOW, INBOX_GROUPS, groupInbox, itemKey, markedRead, newest, REASON_TAG } from "./inbox-view.ts";
import { STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { NewIssueLink } from "./new-issue-page.tsx";
import { INBOX_ALL_PATH } from "./routes.ts";
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

interface Props {
  readonly inbox: InboxState;
  /** Whether the Closed issues list shows every item rather than the newest. */
  readonly showAll: boolean;
  readonly navigate: (path: string) => void;
}

export function InboxPage({ inbox, showAll, navigate }: Props) {
  const { load } = inbox;
  const header = (
    <header className="page-header">
      <h1>Inbox</h1>
      <NewIssueLink navigate={navigate} />
    </header>
  );
  if (load.kind === "failed") {
    return (
      <div className="inbox">
        {header}
        <p className="notice" role="alert">
          Please reload the page
        </p>
      </div>
    );
  }
  if (load.kind === "loading") return <div className="inbox" aria-busy="true" />;

  const groups = groupInbox(load.items);
  return (
    <div className="inbox">
      {header}
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
          <section key={group.id} className="panel" aria-labelledby={headingId}>
            <h2 id={headingId}>
              {group.label} <span className="muted">{items.length}</span>
            </h2>
            {items.length === 0 ? (
              <p className="muted">None</p>
            ) : (
              <ol className="inbox-items">
                {shown.map((item) => (
                  <InboxRow
                    key={itemKey(item)}
                    item={item}
                    marking={inbox.marking.has(itemKey(item))}
                    onMarkRead={inbox.markRead}
                    navigate={navigate}
                  />
                ))}
              </ol>
            )}
            {shown.length < items.length ? (
              <a className="show-all" href={INBOX_ALL_PATH} aria-describedby={headingId} onClick={linkHandler(navigate, INBOX_ALL_PATH)}>
                Show all
              </a>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

interface RowProps {
  readonly item: InboxEntry;
  readonly marking: boolean;
  readonly onMarkRead: (item: InboxEntry) => void;
  readonly navigate: (path: string) => void;
}

function InboxRow({ item, marking, onMarkRead, navigate }: RowProps) {
  const path = `/issues/${item.issueId}`;
  const reasonTag = REASON_TAG[item.reason];
  const titleId = `inbox-item-${itemKey(item)}`;
  return (
    <li className={item.read ? "inbox-item" : "inbox-item unread"}>
      <a id={titleId} className="inbox-title" href={path} onClick={linkHandler(navigate, path)}>
        <span className="issue-number">#{item.issueId}</span> {item.title}
      </a>
      <div className="inbox-facts">
        {item.read ? null : <span className="tag tag-unread">Unread</span>}
        <span className={`tag state-${item.state}`}>{STATE_LABEL[item.state] ?? item.state}</span>
        {reasonTag === undefined ? null : <span className="tag">{reasonTag}</span>}
        <time className="muted" dateTime={item.raisedAt}>
          {raisedLabel(item.raisedAt)}
        </time>
      </div>
      {item.read ? null : (
        <button
          type="button"
          className="button inbox-mark"
          disabled={marking}
          aria-describedby={titleId}
          onClick={() => onMarkRead(item)}
        >
          Mark read
        </button>
      )}
    </li>
  );
}

const RAISED_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function raisedLabel(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : RAISED_FORMAT.format(time);
}
