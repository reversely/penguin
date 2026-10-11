// The board (PRD section 8): columns Detected, Fixing, Verifying, In review and Done; one swimlane per
// owner, opened by that owner's identities with each running session's status; a card per issue and
// assignee with the assignee's character or initial, the session status, the checks, the reviewers
// and what the issue waits on; and the Penguin character for the whole board. A session status always
// shows as text, with a coloured dot beside it while it runs. The board reads itself again on every
// live change, including a session going online or offline. Every value renders as React text, so markup in a title
// or a handle shows as text and runs nothing.

import type { Board, BoardIdentity } from "@penguin/protocol";
import { useEffect, useState } from "react";

import { fetchBoard, SignedOut } from "./api.ts";
import { IdentityAvatar, PersonAvatar } from "./avatar.tsx";
import {
  boardLanes,
  boardPenguinState,
  COLUMNS,
  columnCounts,
  doneCards,
  SESSION_STATUS_LABEL,
  sessionStatuses,
  type Card,
  type Lane,
  type SessionStatus,
} from "./board-view.ts";
import { Icon } from "./icon.tsx";
import { PenguinIndicator, SignalTag } from "./issue-page.tsx";
import { authorName } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { NewIssueLink } from "./new-issue-page.tsx";
import { BOARD_ALL_PATH } from "./routes.ts";
import type { Live } from "./use-live.ts";

type Load = { readonly kind: "loading" } | { readonly kind: "ready"; readonly board: Board } | { readonly kind: "failed" };

interface Props {
  readonly viewer: string;
  /** Whether each lane's Done column shows every card rather than the newest. */
  readonly showAll: boolean;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export function BoardPage({ viewer, showAll, live, navigate, onSignedOut }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const connected = live.status === "live";

  useEffect(() => {
    let current = true;
    fetchBoard().then(
      (board) => {
        if (current) setLoad({ kind: "ready", board });
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        // A failed refresh keeps the board already shown.
        else if (current) setLoad((previous) => (previous.kind === "ready" ? previous : { kind: "failed" }));
      },
    );
    return () => {
      current = false;
    };
    // `connected` reads the board again after a reconnect, which may have missed a change. The board
    // shows each owner's identities, so an identity change reads it again too.
  }, [live.revision, live.identitiesRevision, connected, onSignedOut]);

  if (load.kind === "failed") {
    return (
      <div className="board">
        <h1>Board</h1>
        <p className="notice" role="alert">
          Please reload the page
        </p>
      </div>
    );
  }
  if (load.kind === "loading") return <div className="board" aria-busy="true" />;

  return <BoardView board={load.board} viewer={viewer} showAll={showAll} navigate={navigate} />;
}

interface ViewProps {
  readonly board: Board;
  readonly viewer: string;
  readonly showAll: boolean;
  readonly navigate: (path: string) => void;
}

/** The board as read, without the fetch, so it renders on the server in a test. */
export function BoardView({ board, viewer, showAll, navigate }: ViewProps) {
  const counts = columnCounts(board);
  const lanes = boardLanes(board, viewer);
  const statuses = sessionStatuses(board);
  return (
    <div className="board">
      <header className="page-header">
        <h1>Board</h1>
        <PenguinIndicator state={boardPenguinState(board)} />
        <NewIssueLink navigate={navigate} />
      </header>
      {lanes.length === 0 ? <p className="muted">No issues yet</p> : null}
      {lanes.length === 0 ? null : (
        <div className="board-columns" aria-hidden="true">
          {COLUMNS.map((column) => (
            <div key={column.id} className="board-column-head">
              {column.label} <span className="muted">{counts[column.id]}</span>
            </div>
          ))}
        </div>
      )}
      {lanes.map((lane) => (
        <LaneView key={lane.owner ?? ""} lane={lane} statuses={statuses} showAll={showAll} navigate={navigate} />
      ))}
    </div>
  );
}

interface LaneProps {
  readonly lane: Lane;
  readonly statuses: ReadonlyMap<string, SessionStatus>;
  readonly showAll: boolean;
  readonly navigate: (path: string) => void;
}

function LaneView({ lane, statuses, showAll, navigate }: LaneProps) {
  const id = `lane-${lane.owner ?? "unassigned"}`;
  const running = lane.identities.filter((identity) => identity.sessions.length > 0);
  const idle = lane.identities.filter((identity) => identity.sessions.length === 0);
  return (
    <section className="lane" aria-labelledby={id}>
      <header className="lane-head">
        <h2 id={id} className="lane-owner">
          {lane.owner === null ? null : <PersonAvatar id={lane.owner} size="card" />}
          {lane.owner ?? "Unassigned"}
        </h2>
        {running.length === 0 ? null : (
          <ul className="lane-identities">
            {running.map((identity) => (
              <IdentityRow key={identity.handle} identity={identity} statuses={statuses} />
            ))}
          </ul>
        )}
        {idle.length === 0 ? null : <IdleIdentities identities={idle} labelId={`${id}-idle`} />}
      </header>
      <div className="lane-grid">
        {COLUMNS.map((column) => {
          const cards = lane.columns[column.id];
          const shown = column.id === "done" ? doneCards(cards, showAll) : cards;
          const headingId = `${id}-${column.id}`;
          return (
            <section
              key={column.id}
              className={cards.length === 0 ? "lane-column empty" : "lane-column"}
              aria-labelledby={headingId}
            >
              <h3 id={headingId} className="lane-column-title">
                {column.label} <span className="muted">{cards.length}</span>
              </h3>
              <ol className="cards">
                {shown.map((card) => (
                  <CardView key={card.key} card={card} navigate={navigate} />
                ))}
              </ol>
              {shown.length < cards.length ? (
                <a
                  className="show-all"
                  href={BOARD_ALL_PATH}
                  aria-describedby={headingId}
                  onClick={linkHandler(navigate, BOARD_ALL_PATH)}
                >
                  Show all
                  <Icon name="chevron" />
                </a>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}

/** A session status as a chip: a dot while a session works, waits or is blocked, then its label. */
function StatusChip({ status, id }: { status: SessionStatus | null; id?: string }) {
  const slug = status === null ? "none" : status.replaceAll(" ", "-");
  return (
    <span id={id} className={`tag status status-${slug}`}>
      {status === null ? "No session" : SESSION_STATUS_LABEL[status]}
    </span>
  );
}

interface IdentityRowProps {
  readonly identity: BoardIdentity;
  readonly statuses: ReadonlyMap<string, SessionStatus>;
}

function IdentityName({ identity }: { identity: BoardIdentity }) {
  return (
    <div className="lane-identity-name">
      <span className="row-title">{identity.handle}</span>
      {identity.team ? <span className="tag">Team</span> : null}
    </div>
  );
}

/** An identity with running sessions as a list row: its character, its handle, then a line per session. */
function IdentityRow({ identity, statuses }: IdentityRowProps) {
  return (
    <li className="lane-identity">
      <IdentityAvatar handle={identity.handle} image={identity.avatar} size="row" />
      <div className="lane-identity-text">
        <IdentityName identity={identity} />
        {identity.sessions.map((session) => (
          <div key={session.id} className="lane-session">
            <StatusChip status={statuses.get(session.id) ?? "working"} />
            <span className="tag">{session.vendor}</span>
            {/* A long branch ends in an ellipsis; the title holds it whole for a pointer. */}
            <code className="lane-branch" title={session.branch}>
              {session.branch}
            </code>
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * The identities with no session under one "No session" status, each as its character and handle.
 * Repeating the status on every row would make a lane of many identities a long list before its cards.
 */
function IdleIdentities({ identities, labelId }: { identities: readonly BoardIdentity[]; labelId: string }) {
  return (
    <div className="lane-idle">
      <StatusChip status={null} id={labelId} />
      <ul className="lane-idle-list" aria-labelledby={labelId}>
        {identities.map((identity) => (
          <li key={identity.handle} className="lane-idle-identity">
            <IdentityAvatar handle={identity.handle} image={identity.avatar} size="row" />
            <IdentityName identity={identity} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardView({ card, navigate }: { card: Card; navigate: (path: string) => void }) {
  const { issue, assignee, status, checks, reviewers, waitsOn } = card;
  const path = `/issues/${issue.issue.id}`;
  return (
    <li className="card">
      <div className="card-assignee">
        {assignee === null ? null : assignee.kind === "identity" ? (
          <IdentityAvatar handle={assignee.id} image={card.identity?.avatar ?? null} size="card" />
        ) : (
          <PersonAvatar id={assignee.id} size="card" />
        )}
        <span className={assignee === null ? "muted" : "row-title"}>{assignee?.id ?? "Unassigned"}</span>
      </div>
      <a className="card-title" href={path} onClick={linkHandler(navigate, path)}>
        <span className="issue-number">#{issue.issue.id}</span> {issue.issue.title}
      </a>
      <dl className="card-facts">
        {status === null ? null : (
          <div>
            <dt>Session</dt>
            <dd>
              <StatusChip status={status} />
            </dd>
          </div>
        )}
        <div>
          <dt>Checks</dt>
          <dd>
            {checks.passed + checks.failed + checks.errored === 0 ? <span className="muted">None</span> : null}
            {checks.failed === 0 ? null : <SignalTag signal="failure">{`${checks.failed} failed`}</SignalTag>}
            {checks.errored === 0 ? null : <SignalTag signal="warning">{`${checks.errored} errored`}</SignalTag>}
            {checks.passed === 0 ? null : <SignalTag signal="verified">{`${checks.passed} passed`}</SignalTag>}
          </dd>
        </div>
        <div>
          <dt>Reviewers</dt>
          <dd>
            {reviewers.length === 0 ? <span className="muted">None</span> : null}
            {reviewers.map((review) => (
              <span key={review.opId} className="card-review">
                <SignalTag signal="review">
                  {`${authorName(review.reviewer)} ${review.verdict === "approve" ? "approved" : "requested changes"}`}
                </SignalTag>
                {review.counts ? null : (
                  <span className="tag" title={review.uncountedReason ?? undefined}>
                    Not counted
                  </span>
                )}
              </span>
            ))}
          </dd>
        </div>
        {waitsOn === null ? null : (
          <div>
            <dt>Waits on</dt>
            <dd>{waitsOn}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}
