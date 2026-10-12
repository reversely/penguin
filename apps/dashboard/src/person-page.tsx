// The person page (PRD 0.5 section 10, #136): what waits on the person, their features grouped by
// where they stand (needing a person first, then in progress, then those on main folded behind a
// count), the scopes they are DRI for with how those meet everyone else's, their steward and agents,
// and the issues that involve them. It sits under the person's team in the breadcrumb. The role reads
// GET /api/people/<id>/scopes; the rest comes from the shell's GET /api/team. Every value renders as
// React text.

import type { Board, PersonScopes, TeamFeature, TeamView } from "@penguin/protocol";
import { useCallback, useMemo } from "react";

import { Agent } from "./agent-directory.tsx";
import { fetchPersonScopes } from "./api.ts";
import { PersonAvatar, usePersonHue } from "./avatar.tsx";
import { Disclosure } from "./disclosure.tsx";
import { exceptionText } from "./feature-view.ts";
import { Breadcrumb, hierarchyCrumbs, StewardCell, viewTeams } from "./hierarchy-parts.tsx";
import { GROUP_LABEL, groupFeatures, personAgents, SETTLED, taskText, waitingByFeature, waitingText, waitingTotal, type FeatureGroup } from "./hierarchy-view.ts";
import { useRead } from "./inbox-page.tsx";
import { STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { useArrivals } from "./motion.tsx";
import { RoleTables } from "./role-tables.tsx";
import { featurePath } from "./routes.ts";
import { StageStrip } from "./timeline.tsx";
import { INVOLVEMENT_LABEL, personIssues, type PersonIssue } from "./team-view.ts";
import type { Live } from "./use-live.ts";

interface PersonProps {
  readonly view: TeamView;
  /** The board, for the issues that involve the person; undefined while it is read or when it failed. */
  readonly board: Board | undefined;
  readonly person: string;
  readonly navigate: (path: string) => void;
  /** The person's full role; undefined while it is read, null when the read failed. */
  readonly scopes: PersonScopes | null | undefined;
}

/**
 * The person page with its role tables, read from GET /api/people/<id>/scopes again on every live
 * message, as the team view is.
 */
export function PersonPage({ live, onSignedOut, ...props }: Omit<PersonProps, "scopes"> & { readonly live: Live; readonly onSignedOut: () => void }) {
  const read = useCallback(() => fetchPersonScopes(props.person), [props.person]);
  const scopes = useRead(read, `${live.revision}:${live.featuresRevision}:${live.status === "live"}`, onSignedOut);
  const shown = scopes.kind === "ready" && scopes.value.person === props.person ? scopes.value : scopes.kind === "failed" ? null : undefined;
  return <PersonView {...props} scopes={shown} />;
}

/** One person, as read, without the fetch, so it renders on the server in a test. */
export function PersonView({ view, board, person, navigate, scopes }: PersonProps) {
  const hue = usePersonHue(person);
  const found = view.people.find((entry) => entry.id === person);
  const issues = useMemo(() => (board === undefined ? [] : personIssues(board, person)), [board, person]);
  const crumbs = hierarchyCrumbs(viewTeams(view), { person });
  if (found === undefined) {
    return (
      <div className="team">
        <Breadcrumb crumbs={crumbs} navigate={navigate} />
        <h1>Person not found</h1>
        <p className="muted">Please choose a person on the team page</p>
      </div>
    );
  }
  const waiting = waitingByFeature(found.waiting ?? []);
  const groups = groupFeatures(found.features);
  const { idle } = personAgents(found);
  const steward = found.steward ?? null;
  return (
    <article className="team person-view" aria-labelledby="person-heading">
      <Breadcrumb crumbs={crumbs} navigate={navigate} />
      <header className={`person-head person-${hue}`}>
        <PersonAvatar id={person} size="header" />
        <h1 id="person-heading">{person}</h1>
      </header>
      {waiting.length === 0 ? null : (
        <section className="team-section" aria-labelledby="person-waiting">
          <h2 id="person-waiting" className="team-section-heading">
            Waiting <span className="tab-count">{waitingTotal(found)}</span>
          </h2>
          <ul className="waiting-rows">
            {waiting.map((each) => {
              const path = featurePath(each.feature);
              return (
                <li key={each.feature} className="waiting-row">
                  <a className="feature-row-link" href={path} onClick={linkHandler(navigate, path)}>
                    {each.feature}
                  </a>
                  <span className="waiting-kinds">
                    {each.items.map((item) => (
                      <span key={item.kind} className="tag tag-attention">
                        {waitingText(item)}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className={`team-section person-${hue}`} aria-labelledby="person-features">
        <h2 id="person-features" className="team-section-heading">
          Features <span className="tab-count">{found.features.length}</span>
        </h2>
        {found.features.length === 0 ? <p className="muted person-empty">No features</p> : null}
        {(["person", "running"] as const).map((group) =>
          groups[group].length === 0 ? null : (
            <section key={group} className="feature-group" aria-labelledby={`group-${group}`}>
              <h3 id={`group-${group}`} className="role-table-heading">
                {GROUP_LABEL[group]} <span className="tab-count">{groups[group].length}</span>
              </h3>
              <FeatureList owner={person} group={group} features={groups[group]} navigate={navigate} />
            </section>
          ),
        )}
        {SETTLED.map((group) =>
          groups[group].length === 0 ? null : (
            <Disclosure
              key={group}
              className="feature-group feature-group-main"
              summary={
                <span className="role-table-heading">
                  {GROUP_LABEL[group]} <span className="tab-count">{groups[group].length}</span>
                </span>
              }
            >
              <FeatureList owner={person} group={group} features={groups[group]} navigate={navigate} />
            </Disclosure>
          ),
        )}
      </section>
      <section className="team-section" aria-labelledby="person-role">
        <h2 id="person-role" className="team-section-heading">
          Scopes
        </h2>
        {scopes === undefined ? (
          <div className="role-tables" aria-busy="true" />
        ) : scopes === null ? (
          <p className="notice" role="alert">
            Please reload the page
          </p>
        ) : (
          <RoleTables role={scopes.role} teams={viewTeams(view)} navigate={navigate} />
        )}
      </section>
      {steward === null && idle.length === 0 ? null : (
        <section className="team-section" aria-labelledby="person-agents">
          <h2 id="person-agents" className="team-section-heading">
            Agents
          </h2>
          <dl className="role person-agents">
            {steward === null ? null : (
              <div className="role-row steward-row">
                <dt>Steward</dt>
                <dd>
                  <StewardCell steward={steward} person={person} navigate={navigate} />
                </dd>
              </div>
            )}
            {idle.length === 0 ? null : (
              <div className="role-row">
                <dt>
                  On no feature <span className="tab-count">{idle.length}</span>
                </dt>
                <dd>
                  <ul className="agent-list">
                    {idle.map((agent) => (
                      <li key={agent.handle}>
                        <Agent handle={agent.handle} person={agent.person} variant="compact" navigate={navigate} />
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
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

/**
 * The person's features of one group, each with its timeline strip, its exceptions, its builders'
 * open tasks and its agents. A feature on main lists no agents: its builders have finished.
 */
function FeatureList({ owner, group, features, navigate }: { readonly owner: string; readonly group: FeatureGroup; readonly features: readonly TeamFeature[]; readonly navigate: (path: string) => void }) {
  const arrival = useArrivals(features.map((feature) => feature.id), `${owner}:${group}`);
  return (
    <ul className="feature-rows" aria-label={`${owner}'s features ${GROUP_LABEL[group]}`}>
      {features.map((feature) => (
        <FeatureRow key={feature.id} feature={feature} agents={!SETTLED.includes(group)} arrival={arrival(feature.id)} navigate={navigate} />
      ))}
    </ul>
  );
}

function FeatureRow({ feature, agents, arrival, navigate }: { readonly feature: TeamFeature; readonly agents: boolean; readonly arrival: string | undefined; readonly navigate: (path: string) => void }) {
  const path = featurePath(feature.id);
  const tasks = feature.builderTasks === undefined ? null : taskText(feature.builderTasks);
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
      {!agents || (feature.agents.length === 0 && tasks === null) ? null : (
        <span className="feature-row-agents">
          {feature.agents.length === 0 ? null : (
            <ul className="agent-list" aria-label={`${feature.id}'s agents`}>
              {feature.agents.map((agent) => (
                <li key={agent.handle}>
                  <Agent handle={agent.handle} person={agent.person} variant="compact" online={agent.online} navigate={navigate} />
                </li>
              ))}
            </ul>
          )}
          {tasks === null ? null : (
            <span className="stage-tasks" data-asked={feature.builderTasks !== undefined && feature.builderTasks.asked > 0 ? true : undefined}>
              {tasks}
            </span>
          )}
        </span>
      )}
    </li>
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
