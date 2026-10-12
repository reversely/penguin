// The person page's role (#134): every scope the person owns, reads and is read by, one table per row
// of the role, read from GET /api/people/<id>/scopes. Each table sorts by any column and the filters
// above them narrow all three by text and by where the dependency comes from (role-view.ts). Every
// value renders as React text.

import type { PersonRole, RoleDerivation, RoleScope, TeamSummary } from "@penguin/protocol";
import { useMemo, useState } from "react";

import { shortSha } from "./feature-view.ts";
import { Icon } from "./icon.tsx";
import { PersonPill } from "./pills.tsx";
import {
  DEFAULT_SORT,
  nextSort,
  ROLE_ROWS,
  roleCount,
  roleRows,
  roleScopes,
  roleSource,
  SOURCE_FILTERS,
  SOURCE_TAGS,
  sourceMatches,
  type RoleKey,
  type RoleSort,
  type RoleSortKey,
  type SourceFilter,
} from "./role-view.ts";

const COLUMNS: readonly { readonly key: RoleSortKey; readonly label: string }[] = [
  { key: "scope", label: "Scope" },
  { key: "owner", label: "Owner" },
  { key: "calls", label: "Call sites" },
  { key: "source", label: "Source" },
  { key: "updated", label: "Updated" },
];

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

interface Props {
  readonly role: PersonRole;
  readonly teams: readonly TeamSummary[];
  readonly navigate: (path: string) => void;
}

/** The derivation line, the filters and one table per row of the role. */
export function RoleTables({ role, teams, navigate }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SourceFilter>(null);
  const teamNames = useMemo(() => new Map(teams.filter((team) => !team.implicit).map((team) => [team.id, team.name])), [teams]);
  const ownNames = useMemo(() => new Map(role.scopes.map((scope) => [scope.id, scope.name])), [role.scopes]);
  const all = ROLE_ROWS.flatMap((row) => (row.key === "owns" ? [] : roleScopes(role, row.key)));
  return (
    <div className="role-tables">
      <Derivation derivation={role.derivation ?? null} />
      <div className="role-filters">
        <input
          type="search"
          className="role-search"
          aria-label="Filter scopes"
          placeholder="Scope or owner"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="record-filter" role="group" aria-label="Source">
          {SOURCE_FILTERS.map((each) => (
            <button key={each.label} type="button" className="pill pill-filter" aria-pressed={filter === each.key} onClick={() => setFilter(each.key)}>
              {each.label} <span className="tab-count">{all.filter((scope) => sourceMatches(roleSource(scope, role.derivation), each.key)).length}</span>
            </button>
          ))}
        </div>
      </div>
      {ROLE_ROWS.map((row) => (
        <RoleTable
          key={row.key}
          kind={row.key}
          label={row.label}
          count={roleCount(role, row.key)}
          scopes={roleScopes(role, row.key)}
          derivation={role.derivation ?? null}
          query={query}
          // Ownership comes from penguin/scopes.json alone, so the source filter leaves Owns whole.
          filter={row.key === "owns" ? null : filter}
          teamNames={teamNames}
          ownNames={ownNames}
          navigate={navigate}
        />
      ))}
    </div>
  );
}

/** Which main commit the counts were read from, or that only declared dependencies show yet. */
function Derivation({ derivation }: { readonly derivation: RoleDerivation | null }) {
  if (derivation === null) return <p className="muted role-derivation">Reads show declared dependencies until the next promotion of main</p>;
  return (
    <p className="muted role-derivation">
      Read from main at <code title={derivation.promotion}>{shortSha(derivation.promotion)}</code>
      {derivation.complete ? null : <span className="tag tag-attention">Incomplete</span>}
    </p>
  );
}

interface TableProps {
  readonly kind: RoleKey;
  readonly label: string;
  readonly count: number;
  readonly scopes: readonly RoleScope[];
  readonly derivation: RoleDerivation | null;
  readonly query: string;
  readonly filter: SourceFilter;
  readonly teamNames: ReadonlyMap<string, string>;
  readonly ownNames: ReadonlyMap<string, string>;
  readonly navigate: (path: string) => void;
}

function RoleTable({ kind, label, count, scopes, derivation, query, filter, teamNames, ownNames, navigate }: TableProps) {
  const [sort, setSort] = useState<RoleSort>(DEFAULT_SORT);
  const rows = useMemo(() => roleRows(scopes, derivation, query, filter, sort), [scopes, derivation, query, filter, sort]);
  const id = `role-${kind}`;
  return (
    <section className="role-table-section" id={id} aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="role-table-heading">
        {label} <span className="tab-count">{count}</span>
      </h3>
      {scopes.length === 0 ? (
        <p className="muted">None</p>
      ) : rows.length === 0 ? (
        <p className="muted">Please clear the filters to see every scope</p>
      ) : (
        <div className="table-scroll">
          <table className="people-table role-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : undefined}>
                    <button type="button" className="sort-button" onClick={() => setSort(nextSort(sort, column.key))}>
                      {column.label}
                      <span className="sort-mark" data-active={sort.key === column.key ? true : undefined} data-ascending={sort.key === column.key && !sort.descending ? true : undefined}>
                        <Icon name="chevron" />
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((scope) => (
                <RoleLine key={scope.id} scope={scope} kind={kind} derivation={derivation} teamNames={teamNames} ownNames={ownNames} navigate={navigate} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface LineProps {
  readonly scope: RoleScope;
  readonly kind: RoleKey;
  readonly derivation: RoleDerivation | null;
  readonly teamNames: ReadonlyMap<string, string>;
  readonly ownNames: ReadonlyMap<string, string>;
  readonly navigate: (path: string) => void;
}

function RoleLine({ scope, kind, derivation, teamNames, ownNames, navigate }: LineProps) {
  const source = roleSource(scope, derivation);
  const team = teamNames.get(scope.teamId ?? "");
  const updated = scope.updatedAt === null ? undefined : Date.parse(scope.updatedAt);
  return (
    <tr>
      <td>
        <span className="role-scope-name" title={scope.id}>
          {scope.name}
        </span>
        {kind === "owns" || scope.via.length === 0 ? null : (
          <span className="role-via">
            via
            {scope.via.map((own) => (
              <span key={own}>{ownNames.get(own) ?? own}</span>
            ))}
          </span>
        )}
      </td>
      <td>
        <span className="role-owner-cell">
          <PersonPill id={scope.ownerId} navigate={navigate} />
          {team === undefined ? null : <span className="muted">{team}</span>}
        </span>
      </td>
      <td className="role-calls" title={`${scope.uses} use sites`}>
        {scope.calls}
      </td>
      <td>
        <span className="role-source">
          {(kind === "owns" ? ["Declared"] : SOURCE_TAGS[source]).map((tag) => (
            <span key={tag} className={tag === "Not in code" ? "tag tag-attention" : "tag"}>
              {tag}
            </span>
          ))}
        </span>
      </td>
      <td>
        {scope.updatedPromotion === null ? (
          <span className="muted">None</span>
        ) : (
          <code title={updated === undefined || Number.isNaN(updated) ? scope.updatedPromotion : `${scope.updatedPromotion} ${TIME.format(updated)}`}>{shortSha(scope.updatedPromotion)}</code>
        )}
      </td>
    </tr>
  );
}
