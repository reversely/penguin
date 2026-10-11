// The team map (the dashboard's home): one square per person, edged in the person's hue
// (assignPersonHues in character.ts), holding their agents as smaller boxes tinted in that hue. Each
// box shows the agent's character, handle, session status and the number of the issue it holds, and
// opens the agent's card on the identities page. Each square counts what needs the person and opens
// the person's view: their scopes, their agents and the issues that involve them. The map reads the
// board and the identities again on every live change, so a session going online or offline and an
// issue moving show without reload. Every value renders as React text, so markup in a name, handle
// or title shows as text.
//
// The shell reads the board and the identities for the map (useTeam), because the person hues every
// page shows come from the map's people: one read gives the squares and every badge the same hues.

import type { Board, IdentitiesPage } from "@penguin/protocol";
import { useMemo, type ReactNode } from "react";

import { fetchBoard, fetchIdentities } from "./api.ts";
import { IdentityAvatar, PersonAvatar, PersonHuesProvider, usePersonHue } from "./avatar.tsx";
import { boardPenguinState } from "./board-view.ts";
import { assignPersonHues } from "./character.ts";
import { Icon } from "./icon.tsx";
import { useRead, type Read } from "./inbox-page.tsx";
import { PenguinIndicator } from "./issue-page.tsx";
import { STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { Reorder, useArrivals } from "./motion.tsx";
import { NewIssueLink } from "./new-issue-page.tsx";
import { identityPath, personPath } from "./routes.ts";
import {
  AGENT_STATUS_LABEL,
  INVOLVEMENT_LABEL,
  personIssues,
  teamMap,
  teamPeople,
  type Agent,
  type Needs,
  type Person,
  type PersonIssue,
} from "./team-view.ts";
import type { Live } from "./use-live.ts";

/** The board and the identities as the team map reads them. */
export interface Team {
  readonly board: Read<Board>;
  readonly identities: Read<IdentitiesPage>;
}

/** Reads the team for the shell. */
export function useTeam(live: Live, onSignedOut: () => void): Team {
  // A session going online or offline and an identity change each read both again, as a reconnect does.
  const revision = `${live.revision}:${live.identitiesRevision}:${live.status === "live"}`;
  const board = useRead(fetchBoard, revision, onSignedOut);
  const identities = useRead(fetchIdentities, revision, onSignedOut);
  return { board, identities };
}

/** Gives every person avatar and square below it the hues of the team's people. */
export function TeamHues({ team, children }: { readonly team: Team; readonly children: ReactNode }) {
  const { board, identities } = team;
  const hues = useMemo(
    () => assignPersonHues(board.kind === "ready" && identities.kind === "ready" ? teamPeople(board.value, identities.value) : []),
    [board, identities],
  );
  return <PersonHuesProvider value={hues}>{children}</PersonHuesProvider>;
}

interface Props {
  readonly team: Team;
  readonly viewer: string;
  /** The person whose view is open, or null for the whole map. */
  readonly person: string | null;
  readonly navigate: (path: string) => void;
}

export function TeamPage({ team, viewer, person, navigate }: Props) {
  const { board, identities } = team;
  if (board.kind === "failed" || identities.kind === "failed") {
    return (
      <div className="team">
        <h1>Team</h1>
        <p className="notice" role="alert">
          Please reload the page
        </p>
      </div>
    );
  }
  // Both arrive before the map paints, so no square grows after it shows.
  if (board.kind === "loading" || identities.kind === "loading") return <div className="team" aria-busy="true" />;
  const props = { board: board.value, page: identities.value, viewer, navigate };
  return person === null ? <TeamMapView {...props} /> : <PersonView {...props} person={person} />;
}

interface ViewProps {
  readonly board: Board;
  readonly page: IdentitiesPage;
  readonly viewer: string;
  readonly navigate: (path: string) => void;
}

/** The map as read, without the fetch, so it renders on the server in a test. */
export function TeamMapView({ board, page, viewer, navigate }: ViewProps) {
  const map = useMemo(() => teamMap(board, page, viewer), [board, page, viewer]);
  return (
    <div className="team">
      <header className="page-header">
        <h1>Team</h1>
        <PenguinIndicator state={boardPenguinState(board)} />
        <NewIssueLink navigate={navigate} />
      </header>
      {map.people.length === 0 ? <p className="muted">Please add an owner to penguin/scopes.json</p> : null}
      <ul className="team-map">
        {map.people.map((person) => (
          <PersonSquare key={person.id} person={person} navigate={navigate} />
        ))}
      </ul>
      {map.unassigned.length === 0 ? null : (
        <section className="team-section" aria-labelledby="team-unassigned">
          <h2 id="team-unassigned" className="team-section-heading">
            Unassigned <span className="tab-count">{map.unassigned.length}</span>
          </h2>
          <IssueList scope="unassigned" rows={map.unassigned.map((issue) => ({ issue, involvement: [] }))} navigate={navigate} />
        </section>
      )}
    </div>
  );
}

function PersonSquare({ person, navigate }: { person: Person; navigate: (path: string) => void }) {
  const path = personPath(person.id);
  const hue = usePersonHue(person.id);
  return (
    <li className={`person-square person-${hue}`}>
      <h2 className="person-square-head">
        <a className="person-square-link" href={path} onClick={linkHandler(navigate, path)}>
          <PersonAvatar id={person.id} size="row" />
          <span className="person-square-name">{person.id}</span>
          <Icon name="chevron" />
        </a>
      </h2>
      <NeedsTags needs={person.needs} />
      <AgentBoxes owner={person.id} agents={person.agents} navigate={navigate} />
    </li>
  );
}

const NEEDS: readonly { readonly key: keyof Needs; readonly one: string; readonly many: string }[] = [
  { key: "reviews", one: "review", many: "reviews" },
  { key: "threads", one: "thread", many: "threads" },
  { key: "sessions", one: "session to start", many: "sessions to start" },
];

/** What waits on the person, as counted tags; nothing when nothing does. */
function NeedsTags({ needs }: { needs: Needs }) {
  const shown = NEEDS.filter(({ key }) => needs[key] > 0);
  if (shown.length === 0) return null;
  return (
    <ul className="person-needs" aria-label="Waiting">
      {shown.map(({ key, one, many }) => (
        <li key={key} className="person-need">
          {`${needs[key]} ${needs[key] === 1 ? one : many}`}
        </li>
      ))}
    </ul>
  );
}

interface BoxesProps {
  /** The person whose square holds the boxes. */
  readonly owner: string;
  readonly agents: readonly Agent[];
  readonly navigate: (path: string) => void;
}

/**
 * The person's agents. A session going online or offline reorders them, so each box slides to its new
 * place; a box a live change adds slides in.
 */
function AgentBoxes({ owner, agents, navigate }: BoxesProps) {
  const handles = agents.map((agent) => agent.identity.handle);
  const arrival = useArrivals(handles, owner);
  if (agents.length === 0) return <p className="muted person-empty">No agents</p>;
  return (
    <Reorder className="agent-boxes" order={handles.join(" ")}>
      {agents.map((agent) => (
        <li key={agent.identity.handle} data-key={agent.identity.handle} data-arrival={arrival(agent.identity.handle)}>
          <AgentBox owner={owner} agent={agent} navigate={navigate} />
        </li>
      ))}
    </Reorder>
  );
}

/** One agent: its character, handle, status dot and label, and the issue it holds. */
function AgentBox({ owner, agent, navigate }: { owner: string; agent: Agent; navigate: (path: string) => void }) {
  const { identity, status, held } = agent;
  const [first] = held;
  // Inside its owner's square a handle's "@owner/" half repeats the square's name, so it is read but not shown.
  const prefix = `@${owner}/`;
  const own = identity.handle.startsWith(prefix);
  const body = (
    <>
      <IdentityAvatar handle={identity.handle} image={identity.avatar} size="row" />
      <span className="agent-box-text">
        <span className="agent-box-top">
          <span className="agent-box-handle" title={identity.handle}>
            {own ? <span className="visually-hidden">{prefix}</span> : null}
            {own ? identity.handle.slice(prefix.length) : identity.handle}
          </span>
          {first === undefined ? null : (
            // "+2" counts the other open issues the agent holds; the title lists them.
            <span className="agent-box-issue" title={held.map((issue) => `#${issue.issue.id}`).join(" ")}>
              #{first.issue.id}
              {held.length > 1 ? ` +${held.length - 1}` : ""}
              {held.length > 1 ? <span className="visually-hidden"> more issues</span> : null}
            </span>
          )}
        </span>
        <span className={`agent-status agent-status-${status.replaceAll(" ", "-")}`}>
          <span className="agent-status-dot" aria-hidden="true" />
          <span className="agent-status-label">{AGENT_STATUS_LABEL[status]}</span>
        </span>
      </span>
    </>
  );
  if (agent.id === null) return <span className="agent-box">{body}</span>;
  const path = identityPath(agent.id);
  return (
    <a className="agent-box" href={path} onClick={linkHandler(navigate, path)}>
      {body}
    </a>
  );
}

/** One person: their scopes, their agents and the issues that involve them. */
export function PersonView({ board, page, viewer, navigate, person }: ViewProps & { readonly person: string }) {
  const hue = usePersonHue(person);
  const found = useMemo(() => teamMap(board, page, viewer).people.find((entry) => entry.id === person), [board, page, viewer, person]);
  const issues = useMemo(() => personIssues(board, person), [board, person]);
  const back = (
    <a className="back-link" href="/" onClick={linkHandler(navigate, "/")}>
      <Icon name="back" />
      Team
    </a>
  );
  if (found === undefined) {
    return (
      <div className="team">
        {back}
        <h1>Person not found</h1>
        <p className="muted">Please choose a person on the team map</p>
      </div>
    );
  }
  const scopes = page.scopes.filter((scope) => scope.ownerId === person);
  return (
    <article className="team person-view" aria-labelledby="person-heading">
      {back}
      <header className={`person-head person-${hue}`}>
        <PersonAvatar id={person} size="header" />
        <h1 id="person-heading">{person}</h1>
        <NeedsTags needs={found.needs} />
      </header>
      <section className="team-section" aria-labelledby="person-scopes">
        <h2 id="person-scopes" className="team-section-heading">
          Scopes <span className="tab-count">{scopes.length}</span>
        </h2>
        {scopes.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <ul className="person-scopes">
            {scopes.map((scope) => (
              <li key={scope.id} className="chip" title={scope.id}>
                {scope.name}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={`team-section person-${hue}`} aria-labelledby="person-agents">
        <h2 id="person-agents" className="team-section-heading">
          Agents <span className="tab-count">{found.agents.length}</span>
        </h2>
        <AgentBoxes owner={person} agents={found.agents} navigate={navigate} />
      </section>
      <section className="team-section" aria-labelledby="person-issues">
        <h2 id="person-issues" className="team-section-heading">
          Issues <span className="tab-count">{issues.length}</span>
        </h2>
        {issues.length === 0 ? <p className="muted">None</p> : <IssueList scope={person} rows={issues} navigate={navigate} />}
      </section>
    </article>
  );
}

/** Issues as rows: number and title, then the state and why the issue is on the list. */
function IssueList({ scope, rows, navigate }: { scope: string; rows: readonly PersonIssue[]; navigate: (path: string) => void }) {
  // The scope is the person or the unassigned list, so moving between people adds no arrival.
  const arrival = useArrivals(rows.map(({ issue }) => issue.issue.id), scope);
  return (
    <ul className="team-issues">
      {rows.map(({ issue, involvement }) => (
        <IssueRow key={issue.issue.id} issue={issue} involvement={involvement} arrival={arrival(issue.issue.id)} navigate={navigate} />
      ))}
    </ul>
  );
}

function IssueRow({ issue, involvement, arrival, navigate }: PersonIssue & { arrival: string | undefined; navigate: (path: string) => void }) {
  const { id, title, state } = issue.issue;
  const path = `/issues/${id}`;
  return (
    <li className="team-issue" data-arrival={arrival}>
      <a className="team-issue-title" href={path} onClick={linkHandler(navigate, path)}>
        <span className="issue-number">#{id}</span> {title}
      </a>
      <span className="team-issue-tags">
        <span className={`tag state-${state}`}>{STATE_LABEL[state] ?? state}</span>
        {involvement.map((reason) => (
          <span key={reason} className="tag">
            {INVOLVEMENT_LABEL[reason]}
          </span>
        ))}
      </span>
    </li>
  );
}
