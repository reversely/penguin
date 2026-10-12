// The team view (the dashboard's home, PRD section 10): one square per person, edged in the person's
// hue (assignPersonHues in character.ts). Each square states the person's role in the scope map (the
// scopes they own, the scopes that read theirs, the scopes theirs read and their steward with its
// queue of edit tasks), then each of their
// features with its one-word state and its agents, then their agents on no feature. Only exceptions
// are highlighted: a feature with an exception PRD section 7 routes to a person carries it in the
// attention colour. A feature opens its page; a person opens their view, which adds the issues that
// involve them. The view reads GET /api/team again on every live message. Every value renders as
// React text, so markup in a name, handle or scope shows as text.
//
// The shell reads the team for the view (useTeam), because the person hues every page shows come from
// its people: one read gives the squares and every badge the same hues.

import { ROLE_TOP, type Board, type IdentitiesPage, type PersonScopes, type TeamFeature, type TeamPerson, type TeamView } from "@penguin/protocol";
import { useCallback, useMemo, type ReactNode } from "react";

import { Agent, AgentDirectory } from "./agent-directory.tsx";
import { fetchBoard, fetchIdentities, fetchPersonScopes, fetchTeam } from "./api.ts";
import { PersonAvatar, PersonHuesProvider, usePersonHue } from "./avatar.tsx";
import { assignPersonHues } from "./character.ts";
import { exceptionText } from "./feature-view.ts";
import { Icon } from "./icon.tsx";
import { useRead, type Read } from "./inbox-page.tsx";
import { STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { useArrivals } from "./motion.tsx";
import { featurePath, personPath } from "./routes.ts";
import { ScopePill } from "./pills.tsx";
import { queueCounts } from "./pipeline-view.ts";
import { RoleTables } from "./role-tables.tsx";
import { ROLE_ROWS, roleCount, roleScopes } from "./role-view.ts";
import { StageStrip } from "./timeline.tsx";
import { idleAgents, INVOLVEMENT_LABEL, personIssues, teamPeople, type PersonIssue } from "./team-view.ts";
import type { Live } from "./use-live.ts";

/** The team view, the board and the identities as the shell reads them. */
export interface Team {
  readonly view: Read<TeamView>;
  readonly board: Read<Board>;
  readonly identities: Read<IdentitiesPage>;
}

/**
 * Reads the team for the shell, again on every live message and after a reconnect. The
 * features-changed message reaches every person, so a feature, plan or approval that changes shows on
 * each open team view, not only on the views of the people its inbox items reach.
 */
export function useTeam(live: Live, onSignedOut: () => void): Team {
  const revision = `${live.revision}:${live.inboxRevision}:${live.identitiesRevision}:${live.featuresRevision}:${live.status === "live"}`;
  const view = useRead(fetchTeam, revision, onSignedOut);
  const board = useRead(fetchBoard, revision, onSignedOut);
  const identities = useRead(fetchIdentities, revision, onSignedOut);
  return { view, board, identities };
}

/** The team's people: the view's, the board's and every identity owner. */
export function hueTeam(team: Team): string[] {
  const people = new Set<string>(team.view.kind === "ready" ? team.view.value.people.map((person) => person.id) : []);
  if (team.board.kind === "ready" && team.identities.kind === "ready") for (const id of teamPeople(team.board.value, team.identities.value)) people.add(id);
  return [...people];
}

/** Gives every person avatar and square below it the hues of the team's people, and every agent label its identity. */
export function TeamHues({ team, children }: { readonly team: Team; readonly children: ReactNode }) {
  const hues = useMemo(() => assignPersonHues(hueTeam(team)), [team]);
  return (
    <PersonHuesProvider value={hues}>
      <AgentDirectory page={team.identities.kind === "ready" ? team.identities.value : undefined}>{children}</AgentDirectory>
    </PersonHuesProvider>
  );
}

interface Props {
  readonly team: Team;
  /** The person whose view is open, or null for the whole team. */
  readonly person: string | null;
  readonly navigate: (path: string) => void;
  readonly live: Live;
  readonly onSignedOut: () => void;
}

export function TeamPage({ team, person, navigate, live, onSignedOut }: Props) {
  const { view, board } = team;
  if (view.kind === "failed") {
    return (
      <div className="team">
        <h1>Team</h1>
        <p className="notice" role="alert">
          Please reload the page
        </p>
      </div>
    );
  }
  // The view arrives before the squares paint, so no square grows after it shows.
  if (view.kind === "loading") return <div className="team" aria-busy="true" />;
  if (person === null) return <TeamMapView view={view.value} navigate={navigate} />;
  return <PersonPage view={view.value} board={board.kind === "ready" ? board.value : undefined} person={person} navigate={navigate} live={live} onSignedOut={onSignedOut} />;
}

/**
 * The person view with its role tables, read from GET /api/people/<id>/scopes again on every live
 * message, as the team view is.
 */
function PersonPage({ live, onSignedOut, ...props }: Omit<PersonProps, "scopes"> & { readonly live: Live; readonly onSignedOut: () => void }) {
  const read = useCallback(() => fetchPersonScopes(props.person), [props.person]);
  const scopes = useRead(read, `${live.revision}:${live.featuresRevision}:${live.status === "live"}`, onSignedOut);
  const shown = scopes.kind === "ready" && scopes.value.person === props.person ? scopes.value : scopes.kind === "failed" ? null : undefined;
  return <PersonView {...props} scopes={shown} />;
}

/** The team as read, without the fetch, so it renders on the server in a test. */
export function TeamMapView({ view, navigate }: { readonly view: TeamView; readonly navigate: (path: string) => void }) {
  return (
    <div className="team">
      <header className="page-header">
        <h1>Team</h1>
      </header>
      {view.people.length === 0 ? <p className="muted">Please add an owner to penguin/scopes.json</p> : null}
      <ul className="team-map">
        {view.people.map((person) => (
          <PersonSquare key={person.id} person={person} navigate={navigate} />
        ))}
      </ul>
    </div>
  );
}

function PersonSquare({ person, navigate }: { readonly person: TeamPerson; readonly navigate: (path: string) => void }) {
  const path = personPath(person.id);
  const hue = usePersonHue(person.id);
  const idle = idleAgents(person);
  return (
    <li className={`person-square person-${hue}`} data-exception={person.features.some((feature) => feature.exceptions.length > 0) ? true : undefined}>
      <h2 className="person-square-head">
        <a className="person-square-link" href={path} onClick={linkHandler(navigate, path)}>
          <PersonAvatar id={person.id} size="row" />
          <span className="person-square-name">{person.id}</span>
          <Icon name="chevron" />
        </a>
      </h2>
      <Role person={person} navigate={navigate} />
      <FeatureList owner={person.id} features={person.features} navigate={navigate} />
      {idle.length === 0 ? null : (
        <ul className="agent-list" aria-label={`${person.id}'s agents on no feature`}>
          {idle.map((agent) => (
            <li key={agent.handle}>
              <Agent handle={agent.handle} person={agent.person} variant="compact" navigate={navigate} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The person's role as rows: Owns, Reads and Read by, each with its count and its top scopes by call
 * sites as pills in their DRIs' hues, then how many more the person page lists. A row with no scope is
 * left out, except Owns. With `steward`, the last row is the person's steward, which takes the edits
 * to the scopes they own, with its queue.
 */
function Role({ person, navigate, scopes = true }: { readonly person: TeamPerson; readonly navigate: (path: string) => void; readonly scopes?: boolean }) {
  const { role } = person;
  const steward = person.steward ?? null;
  const rows = scopes ? ROLE_ROWS.filter((row) => row.key === "owns" || roleCount(role, row.key) > 0) : [];
  if (rows.length === 0 && steward === null) return null;
  const path = personPath(person.id);
  return (
    <dl className="role">
      {rows.map((row) => {
        const count = roleCount(role, row.key);
        const shown = roleScopes(role, row.key).slice(0, ROLE_TOP);
        return (
          <div key={row.key} className="role-row">
            <dt>
              {row.label} <span className="tab-count">{count}</span>
            </dt>
            <dd className="role-pills">
              {count === 0 ? (
                <span className="muted">None</span>
              ) : (
                shown.map((scope) => <ScopePill key={scope.id} name={scope.name} owner={scope.ownerId} title={`${scope.id} ${scope.ownerId} ${scope.calls} call sites`} />)
              )}
              {count > shown.length ? (
                <a className="role-more" href={path} onClick={linkHandler(navigate, path)}>
                  {count - shown.length} more
                </a>
              ) : null}
            </dd>
          </div>
        );
      })}
      {steward === null ? null : (
        <div className="role-row steward-row">
          <dt>Steward</dt>
          <dd className="steward">
            <Agent handle={steward.handle} person={person.id} variant="compact" navigate={navigate} />
            <span className="steward-queue">
              {queueCounts(steward).map((count) => (
                <span key={count.key} className="steward-count" data-key={count.key}>
                  {count.text}
                </span>
              ))}
            </span>
          </dd>
        </div>
      )}
    </dl>
  );
}

/** The person's features, each with its state, its exceptions and its agents. */
function FeatureList({ owner, features, navigate }: { readonly owner: string; readonly features: readonly TeamFeature[]; readonly navigate: (path: string) => void }) {
  const arrival = useArrivals(features.map((feature) => feature.id), owner);
  if (features.length === 0) return <p className="muted person-empty">No features</p>;
  return (
    <ul className="feature-rows" aria-label={`${owner}'s features`}>
      {features.map((feature) => (
        <FeatureRow key={feature.id} feature={feature} arrival={arrival(feature.id)} navigate={navigate} />
      ))}
    </ul>
  );
}

function FeatureRow({ feature, arrival, navigate }: { readonly feature: TeamFeature; readonly arrival: string | undefined; readonly navigate: (path: string) => void }) {
  const path = featurePath(feature.id);
  return (
    <li className="feature-row" data-arrival={arrival} data-exception={feature.exceptions.length > 0 ? true : undefined}>
      <span className="feature-row-head">
        <a className="feature-row-link" href={path} onClick={linkHandler(navigate, path)}>
          {feature.id}
        </a>
        <StageStrip strip={feature.strip} />
      </span>
      {feature.exceptions.length === 0 ? null : (
        <ul className="feature-exceptions" aria-label="Exceptions">
          {feature.exceptions.map((exception, index) => (
            <li key={index}>{exceptionText(exception)}</li>
          ))}
        </ul>
      )}
      {feature.agents.length === 0 ? null : (
        <ul className="agent-list" aria-label={`${feature.id}'s agents`}>
          {feature.agents.map((agent) => (
            <li key={agent.handle}>
              <Agent handle={agent.handle} person={agent.person} variant="compact" online={agent.online} navigate={navigate} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface PersonProps {
  readonly view: TeamView;
  /** The board, for the issues that involve the person; undefined while it is read or when it failed. */
  readonly board: Board | undefined;
  readonly person: string;
  readonly navigate: (path: string) => void;
  /** The person's full role; undefined while it is read, null when the read failed. */
  readonly scopes: PersonScopes | null | undefined;
}

/** One person: their role as tables, their features, their agents and the issues that involve them. */
export function PersonView({ view, board, person, navigate, scopes }: PersonProps) {
  const hue = usePersonHue(person);
  const found = view.people.find((entry) => entry.id === person);
  const issues = useMemo(() => (board === undefined ? [] : personIssues(board, person)), [board, person]);
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
        <p className="muted">Please choose a person on the team view</p>
      </div>
    );
  }
  const idle = idleAgents(found);
  return (
    <article className="team person-view" aria-labelledby="person-heading">
      {back}
      <header className={`person-head person-${hue}`}>
        <PersonAvatar id={person} size="header" />
        <h1 id="person-heading">{person}</h1>
      </header>
      <section className="team-section" aria-labelledby="person-role">
        <h2 id="person-role" className="team-section-heading">
          Role
        </h2>
        {scopes === undefined ? (
          <div className="role-tables" aria-busy="true" />
        ) : scopes === null ? (
          <p className="notice" role="alert">
            Please reload the page
          </p>
        ) : (
          <RoleTables role={scopes.role} teams={view.teams ?? []} navigate={navigate} />
        )}
        <Role person={found} navigate={navigate} scopes={false} />
      </section>
      <section className={`team-section person-${hue}`} aria-labelledby="person-features">
        <h2 id="person-features" className="team-section-heading">
          Features <span className="tab-count">{found.features.length}</span>
        </h2>
        <FeatureList owner={person} features={found.features} navigate={navigate} />
      </section>
      {idle.length === 0 ? null : (
        <section className="team-section" aria-labelledby="person-agents">
          <h2 id="person-agents" className="team-section-heading">
            Agents on no feature <span className="tab-count">{idle.length}</span>
          </h2>
          <ul className="agent-list">
            {idle.map((agent) => (
              <li key={agent.handle}>
                <Agent handle={agent.handle} person={agent.person} navigate={navigate} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {issues.length === 0 ? null : (
        <section className="team-section" aria-labelledby="person-issues">
          <h2 id="person-issues" className="team-section-heading">
            Issues <span className="tab-count">{issues.length}</span>
          </h2>
          <IssueList scope={person} rows={issues} navigate={navigate} />
        </section>
      )}
    </article>
  );
}

/** Issues as rows: number and title, then the state and why the issue is on the list. */
function IssueList({ scope, rows, navigate }: { scope: string; rows: readonly PersonIssue[]; navigate: (path: string) => void }) {
  // The scope is the person, so moving between people adds no arrival.
  const arrival = useArrivals(rows.map(({ issue }) => issue.issue.id), scope);
  return (
    <ul className="team-issues">
      {rows.map(({ issue, involvement }) => {
        const { id, title, state } = issue.issue;
        const path = `/issues/${id}`;
        return (
          <li key={id} className="team-issue" data-arrival={arrival(id)}>
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
      })}
    </ul>
  );
}
