// The board (PRD section 8): columns Detected, Fixing, Verifying, In review and Done; one swimlane per
// owner with that owner's identities and their running sessions; a card per issue and assignee with
// the identity's avatar, the session status, the checks, the reviewers and what the issue waits on;
// and the Penguin character for the whole board. The board reads itself again on every live change,
// including a session going online or offline. Every value renders as React text, so markup in a title
// or a handle shows as text and runs nothing.

import type { Board, BoardIdentity } from "@penguin/protocol";
import { useEffect, useState } from "react";

import { fetchBoard, SignedOut } from "./api.ts";
import {
  boardLanes,
  boardPenguinState,
  COLUMNS,
  columnCounts,
  initial,
  SESSION_STATUS_LABEL,
  type Card,
  type Lane,
} from "./board-view.ts";
import { PenguinIndicator, SignalTag } from "./issue-page.tsx";
import { authorName } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import type { Live } from "./use-live.ts";

type Load = { readonly kind: "loading" } | { readonly kind: "ready"; readonly board: Board } | { readonly kind: "failed" };

interface Props {
  readonly viewer: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export function BoardPage({ viewer, live, navigate, onSignedOut }: Props) {
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
    // `connected` reads the board again after a reconnect, which may have missed a change.
  }, [live.revision, connected, onSignedOut]);

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

  const { board } = load;
  const counts = columnCounts(board);
  const lanes = boardLanes(board, viewer);
  return (
    <div className="board">
      <header className="board-header">
        <h1>Board</h1>
        <PenguinIndicator state={boardPenguinState(board)} />
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
        <LaneView key={lane.owner ?? ""} lane={lane} navigate={navigate} />
      ))}
    </div>
  );
}

function LaneView({ lane, navigate }: { lane: Lane; navigate: (path: string) => void }) {
  const id = `lane-${lane.owner ?? "unassigned"}`;
  return (
    <section className="lane" aria-labelledby={id}>
      <header className="lane-head">
        <h2 id={id}>{lane.owner ?? "Unassigned"}</h2>
        {lane.identities.length === 0 ? null : (
          <ul className="lane-identities">
            {lane.identities.map((identity) => (
              <IdentityRow key={identity.handle} identity={identity} />
            ))}
          </ul>
        )}
      </header>
      <div className="lane-grid">
        {COLUMNS.map((column) => {
          const cards = lane.columns[column.id];
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
                {cards.map((card) => (
                  <CardView key={card.key} card={card} navigate={navigate} />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function IdentityRow({ identity }: { identity: BoardIdentity }) {
  return (
    <li className="row lane-identity">
      <Avatar id={identity.handle} image={identity.avatar} />
      <span className="row-title">{identity.handle}</span>
      {identity.team ? <span className="tag">Team</span> : null}
      {identity.sessions.length === 0 ? (
        <span className="tag session-offline">No session</span>
      ) : (
        identity.sessions.map((session) => (
          <span key={session.id} className="lane-session">
            <span className="tag session-running">{session.vendor}</span>
            <code className="muted">{session.branch}</code>
          </span>
        ))
      )}
    </li>
  );
}

function Avatar({ id, image }: { id: string; image: string | null }) {
  // The name beside the avatar says who it is, so the image itself carries no text.
  return image === null ? (
    <span className="avatar avatar-initial" aria-hidden="true">
      {initial(id)}
    </span>
  ) : (
    <img className="avatar" src={image} alt="" />
  );
}

function CardView({ card, navigate }: { card: Card; navigate: (path: string) => void }) {
  const { issue, assignee, status, checks, reviewers, waitsOn } = card;
  const path = `/issues/${issue.issue.id}`;
  return (
    <li className="card">
      <div className="card-assignee">
        {assignee === null ? null : <Avatar id={assignee.id} image={card.identity?.avatar ?? null} />}
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
              <span className={`tag status status-${status.replaceAll(" ", "-")}`}>{SESSION_STATUS_LABEL[status]}</span>
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
