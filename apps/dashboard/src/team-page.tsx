// The team page (PRD 0.5 section 10, #136), the engineering manager's home and the dashboard's landing
// page for the viewer's own team. Under the breadcrumb (Org, the team) come a members table (Person,
// Features by stage, Agents, Waiting on them) and the team's scopes table (Scope, DRI, Reads, Read by,
// Health). Only exceptions are highlighted: a stage needing a person, what waits on a member and a
// scope that is not clean take the attention colour. A person opens their page; a stage pill of one
// feature opens that feature. Every value renders as React text, so markup in a name, handle or scope
// shows as text.
//
// The shell reads the team for every page (useTeam), because the person hues every page shows come
// from its people: one read gives the tables and every badge the same hues, and the org, team and
// person pages make no request of their own besides the person's role.

import type { Board, IdentitiesPage, TeamPerson, TeamSummary, TeamView } from "@penguin/protocol";
import { useMemo, type ReactNode } from "react";

import { AgentDirectory } from "./agent-directory.tsx";
import { fetchBoard, fetchIdentities, fetchTeam } from "./api.ts";
import { PersonHuesProvider } from "./avatar.tsx";
import { assignPersonHues } from "./character.ts";
import { Breadcrumb, hierarchyCrumbs, StagePills, StewardCell, viewTeams, WaitingCell } from "./hierarchy-parts.tsx";
import { healthTags, homeTeam, orderScopes, personAgents, stageBuckets, teamMembers, teamName, waitingTotal } from "./hierarchy-view.ts";
import { useRead, type Read } from "./inbox-page.tsx";
import { linkHandler } from "./links.ts";
import { OrgView } from "./org-page.tsx";
import { PersonPage } from "./person-page.tsx";
import { PersonPill } from "./pills.tsx";
import { ORG_PATH, personPath, type Route } from "./routes.ts";
import { teamPeople } from "./team-view.ts";
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

/** Gives every person avatar below it the hues of the team's people, and every agent label its identity. */
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
  readonly route: Extract<Route, { readonly page: "org" | "team" | "person" }>;
  /** The signed-in person, whose own team is the home page. */
  readonly viewer: string;
  readonly navigate: (path: string) => void;
  readonly live: Live;
  readonly onSignedOut: () => void;
}

/** The org, a team or a person, from the shell's one read of the team. */
export function TeamPage({ team, route, viewer, navigate, live, onSignedOut }: Props) {
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
  // The view arrives before the tables paint, so no row grows after it shows.
  if (view.kind === "loading") return <div className="team" aria-busy="true" />;
  if (route.page === "org") return <OrgView view={view.value} navigate={navigate} />;
  if (route.page === "person") {
    return <PersonPage view={view.value} board={board.kind === "ready" ? board.value : undefined} person={route.person} navigate={navigate} live={live} onSignedOut={onSignedOut} />;
  }
  return <TeamPageView view={view.value} team={route.team} viewer={viewer} navigate={navigate} />;
}

interface TeamPageProps {
  readonly view: TeamView;
  /** The team's id, or null for the viewer's own team. */
  readonly team: string | null;
  readonly viewer: string;
  readonly navigate: (path: string) => void;
}

const NO_ROLE: TeamPerson["role"] = { scopes: [], dependents: [], dependencies: [] };

/** One team as read, without the fetch, so it renders on the server in a test. A viewer in no team gets the org. */
export function TeamPageView({ view, team: id, viewer, navigate }: TeamPageProps) {
  const teams = viewTeams(view);
  const team = id === null ? homeTeam(teams, viewer) : teams.find((each) => each.id === id);
  if (team === undefined && id === null) return <OrgView view={view} navigate={navigate} />;
  if (team === undefined) {
    return (
      <div className="team">
        <Breadcrumb crumbs={[{ label: "Org", path: ORG_PATH }, { label: "Team not found" }]} navigate={navigate} />
        <h1>Team not found</h1>
        <p className="muted">Please choose a team on the org page</p>
      </div>
    );
  }
  const people = new Map(view.people.map((person) => [person.id, person]));
  const members = teamMembers(team).map((member): TeamPerson => people.get(member) ?? { id: member, role: NO_ROLE, features: [], idleAgents: [] });
  return (
    <article className="team hierarchy" aria-labelledby="team-heading">
      <Breadcrumb crumbs={hierarchyCrumbs(teams, { team })} navigate={navigate} />
      <header className="page-header team-head">
        <h1 id="team-heading">{teamName(team)}</h1>
        <span className="team-lead">
          <span className="muted">Lead</span>
          <PersonPill id={team.lead} navigate={navigate} />
        </span>
      </header>
      <section className="team-section" aria-labelledby="team-members">
        <h2 id="team-members" className="team-section-heading">
          Members <span className="tab-count">{members.length}</span>
        </h2>
        <div className="table-scroll">
          <table className="people-table hierarchy-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Features by stage</th>
                <th scope="col">Agents</th>
                <th scope="col">Waiting on them</th>
              </tr>
            </thead>
            <tbody>
              {members.map((person) => (
                <MemberRow key={person.id} person={person} navigate={navigate} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ScopesTable team={team} navigate={navigate} />
    </article>
  );
}

/** One member: their pill, their features as stage pills, their steward's own queue and builders, then what waits on them. */
function MemberRow({ person, navigate }: { readonly person: TeamPerson; readonly navigate: (path: string) => void }) {
  const path = personPath(person.id);
  const { builders } = personAgents(person);
  const steward = person.steward ?? null;
  return (
    <tr data-exception={waitingTotal(person) > 0 ? true : undefined}>
      <th scope="row">
        <PersonPill id={person.id} navigate={navigate} />
      </th>
      <td data-label="Features by stage">
        <StagePills buckets={stageBuckets(person.features)} more={path} navigate={navigate} />
      </td>
      <td data-label="Agents">
        <span className="member-agents">
          {steward === null ? null : <StewardCell steward={steward} person={person.id} navigate={navigate} />}
          {builders.length === 0 ? (
            steward === null ? <span className="muted">None</span> : null
          ) : (
            <a className="role-more" href={path} onClick={linkHandler(navigate, path)}>
              {builders.length === 1 ? "1 builder" : `${builders.length} builders`}
            </a>
          )}
        </span>
      </td>
      <td data-label="Waiting on them">
        <WaitingCell person={person} navigate={navigate} />
      </td>
    </tr>
  );
}

/** The scopes the team owns, those not clean first: each with its DRI, how many scopes it reads and is read by, and its health. */
function ScopesTable({ team, navigate }: { readonly team: TeamSummary; readonly navigate: (path: string) => void }) {
  const scopes = orderScopes(team.scopes);
  return (
    <section className="team-section" aria-labelledby="team-scopes">
      <h2 id="team-scopes" className="team-section-heading">
        Scopes <span className="tab-count">{scopes.length}</span>
      </h2>
      {scopes.length === 0 ? (
        <p className="muted">Please give the team a scope in penguin/scopes.json</p>
      ) : (
        <div className="table-scroll">
          <table className="people-table hierarchy-table scopes-table">
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">DRI</th>
                <th scope="col">Reads</th>
                <th scope="col">Read by</th>
                <th scope="col">Health</th>
              </tr>
            </thead>
            <tbody>
              {scopes.map((scope) => {
                const tags = healthTags(scope);
                return (
                  <tr key={scope.id} data-exception={tags.some((tag) => tag.attention) ? true : undefined}>
                    <th scope="row">
                      <span className="role-scope-name" title={scope.id}>
                        {scope.name}
                      </span>
                    </th>
                    <td data-label="DRI">
                      <PersonPill id={scope.dri} navigate={navigate} />
                    </td>
                    <td className="hierarchy-count" data-label="Reads">{scope.reads ?? <span className="muted">None</span>}</td>
                    <td className="hierarchy-count" data-label="Read by">{scope.readBy ?? <span className="muted">None</span>}</td>
                    <td data-label="Health">
                      <span className="role-source">
                        {tags.map((tag) => (
                          <span key={tag.text} className={tag.attention ? "tag tag-attention" : "tag tag-verified"}>
                            {tag.text}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
