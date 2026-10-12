// The pieces the org, team, person and feature pages share (#136): the breadcrumb that follows the
// hierarchy, features as stage pills with counts, a steward with its own queue and what waits on a
// person. Every value renders as React text.

import type { StewardView, TeamPerson, TeamSummary, TeamView } from "@penguin/protocol";

import { Agent } from "./agent-directory.tsx";
import { homeTeam, taskText, teamName, waitingByFeature, waitingTotal, type StageBucket } from "./hierarchy-view.ts";
import { linkHandler } from "./links.ts";
import { queueCounts } from "./pipeline-view.ts";
import { featurePath, ORG_PATH, personPath, teamPath } from "./routes.ts";

/** One step of the breadcrumb: a link, or the current page when it has no path. */
export interface Crumb {
  readonly label: string;
  readonly path?: string;
  /** Opens an anchor of the current page instead of navigating, such as a part of the feature page. */
  readonly onOpen?: () => void;
}

/** The breadcrumb from the org down to the page: Org, team, person, feature, part, file. */
export function Breadcrumb({ crumbs, navigate }: { readonly crumbs: readonly Crumb[]; readonly navigate: (path: string) => void }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          if (last || crumb.path === undefined) {
            return (
              <li key={index} aria-current={last ? "page" : undefined}>
                {crumb.label}
              </li>
            );
          }
          const onOpen = crumb.onOpen;
          return (
            <li key={index}>
              <a
                href={crumb.path}
                onClick={
                  onOpen === undefined
                    ? linkHandler(navigate, crumb.path)
                    : (event) => {
                        event.preventDefault();
                        onOpen();
                      }
                }
              >
                {crumb.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The crumbs above a page: Org, then the person's team, then the person and the feature as given. A
 * person in no team goes straight under Org.
 */
export function hierarchyCrumbs(teams: readonly TeamSummary[], at: { readonly team?: TeamSummary; readonly person?: string; readonly feature?: string }): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Org", path: ORG_PATH }];
  const team = at.team ?? (at.person === undefined ? undefined : homeTeam(teams, at.person));
  if (team !== undefined) crumbs.push({ label: teamName(team), path: teamPath(team.id) });
  if (at.person !== undefined) crumbs.push({ label: at.person, path: personPath(at.person) });
  if (at.feature !== undefined) crumbs.push({ label: at.feature, path: featurePath(at.feature) });
  return crumbs;
}

/** The view's teams, or none from an older Worker. */
export const viewTeams = (view: TeamView): readonly TeamSummary[] => view.teams ?? [];

/**
 * Features as stage pills with counts. A pill of one feature opens that feature; a pill of several
 * opens `more`, the level that lists them. Builders' open tasks count under their stage's pill.
 */
export function StagePills({ buckets, more, navigate }: { readonly buckets: readonly StageBucket[]; readonly more: string; readonly navigate: (path: string) => void }) {
  if (buckets.length === 0) return <span className="muted">None</span>;
  return (
    <ul className="stage-pills">
      {buckets.map((bucket) => {
        const path = bucket.features.length === 1 ? featurePath(bucket.features[0] as string) : more;
        const tasks = taskText(bucket.tasks);
        return (
          <li key={bucket.key}>
            <a className={bucket.attention ? "pill pill-tone-person" : "pill"} href={path} onClick={linkHandler(navigate, path)} title={bucket.features.join(" ")}>
              {bucket.label}
              {bucket.attention ? <span className="visually-hidden"> needs a person</span> : null}
              <span className="tab-count">{bucket.features.length}</span>
            </a>
            {tasks === null ? null : (
              <span className="stage-tasks" data-asked={bucket.tasks.asked > 0 ? true : undefined}>
                {tasks}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A steward with the counts of the tasks routed to it. */
export function StewardCell({ steward, person, navigate }: { readonly steward: StewardView; readonly person: string; readonly navigate: (path: string) => void }) {
  return (
    <span className="steward">
      <Agent handle={steward.handle} person={person} variant="compact" navigate={navigate} />
      <span className="steward-queue">
        {queueCounts(steward).map((count) => (
          <span key={count.key} className="steward-count" data-key={count.key}>
            {count.text}
          </span>
        ))}
      </span>
    </span>
  );
}

/** How many items wait on a person, then the features holding the most, each opening its page. */
export function WaitingCell({ person, top = 2, navigate }: { readonly person: TeamPerson; readonly top?: number; readonly navigate: (path: string) => void }) {
  const total = waitingTotal(person);
  if (total === 0) return <span className="muted">None</span>;
  const features = waitingByFeature(person.waiting ?? []);
  const shown = features.slice(0, top);
  const path = personPath(person.id);
  return (
    <span className="waiting-cell">
      <a className="waiting-total" href={path} onClick={linkHandler(navigate, path)}>
        {total}
      </a>
      {shown.map((each) => {
        const feature = featurePath(each.feature);
        return (
          <a key={each.feature} className="pill pill-tone-person" href={feature} onClick={linkHandler(navigate, feature)}>
            {each.feature}
            <span className="tab-count">{each.count}</span>
          </a>
        );
      })}
      {features.length > shown.length ? (
        <a className="role-more" href={path} onClick={linkHandler(navigate, path)}>
          {features.length - shown.length} more
        </a>
      ) : null}
    </span>
  );
}
