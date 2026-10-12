// The org page (PRD 0.5 section 10, #136): one row per team with its lead, its members' features by
// stage, what waits on its members and how many of its scopes are clean. A row opens the team. It
// reads nothing of its own: the shell's GET /api/team holds every team. Every value renders as React
// text.

import type { TeamView } from "@penguin/protocol";

import { Breadcrumb, StagePills } from "./hierarchy-parts.tsx";
import { orgRows, teamName } from "./hierarchy-view.ts";
import { linkHandler } from "./links.ts";
import { PersonPill } from "./pills.tsx";
import { teamPath } from "./routes.ts";

export function OrgView({ view, navigate }: { readonly view: TeamView; readonly navigate: (path: string) => void }) {
  const rows = orgRows(view);
  return (
    <article className="team hierarchy" aria-labelledby="org-heading">
      <Breadcrumb crumbs={[{ label: "Org" }]} navigate={navigate} />
      <header className="page-header">
        <h1 id="org-heading">Org</h1>
      </header>
      <section className="team-section" aria-labelledby="org-teams">
        <h2 id="org-teams" className="team-section-heading">
          Teams <span className="tab-count">{rows.length}</span>
        </h2>
        {rows.length === 0 ? (
          <p className="muted">Please add a team to penguin/teams.json</p>
        ) : (
          <div className="table-scroll">
            <table className="people-table hierarchy-table">
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col">Lead</th>
                  <th scope="col">Features by stage</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Health</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const path = teamPath(row.team.id);
                  return (
                    <tr key={row.team.id} data-exception={row.waiting > 0 ? true : undefined}>
                      <th scope="row">
                        <a className="hierarchy-name" href={path} onClick={linkHandler(navigate, path)}>
                          {teamName(row.team)}
                        </a>
                        <span className="muted hierarchy-sub">{row.people === 1 ? "1 person" : `${row.people} people`}</span>
                      </th>
                      <td data-label="Lead">
                        <PersonPill id={row.team.lead} navigate={navigate} />
                      </td>
                      <td data-label="Features by stage">
                        <StagePills buckets={row.stages} more={path} navigate={navigate} />
                      </td>
                      <td className="hierarchy-count" data-label="Waiting">
                        {row.waiting === 0 ? (
                          <span className="muted">None</span>
                        ) : (
                          <a className="waiting-total" href={path} onClick={linkHandler(navigate, path)}>
                            {row.waiting}
                          </a>
                        )}
                      </td>
                      <td className="hierarchy-count" data-label="Health" data-attention={row.clean < row.scopes ? true : undefined}>
                        {row.scopes === 0 ? <span className="muted">No scopes</span> : `${row.clean} of ${row.scopes} scopes clean`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}
