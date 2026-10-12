// What the team view's role rows and the person page's role tables show (#134), derived from a
// person's role (PersonRole in @penguin/protocol). Pure, so the rules are tested without a browser
// (test/role-view.test.ts).
//
// Each row of the role is one of Owns, Reads and Read by. The team view shows each row's count and its
// top scopes by call sites; the person page lists every scope in a table that sorts by any column and
// filters by text and by where the dependency comes from.

import type { PersonRole, RoleDerivation, RoleScope } from "@penguin/protocol";

export type RoleKey = "owns" | "reads" | "readBy";

/** The rows of a role, in the order the team view and the person page show them. */
export const ROLE_ROWS: readonly { readonly key: RoleKey; readonly label: string }[] = [
  { key: "owns", label: "Owns" },
  { key: "reads", label: "Reads" },
  { key: "readBy", label: "Read by" },
];

/** The scopes a role row holds, as the answer carries them. */
export function roleScopes(role: PersonRole, key: RoleKey): readonly RoleScope[] {
  return key === "owns" ? role.scopes : key === "reads" ? role.dependencies : role.dependents;
}

/** A role row's full size: `counts` when the answer carries it, else the scopes it lists. */
export function roleCount(role: PersonRole, key: RoleKey): number {
  return role.counts?.[key] ?? roleScopes(role, key).length;
}

/**
 * Where a dependency comes from. `derived`: the code shows it and `depends_on` does not name it.
 * `both`: both do. `declared`: only `depends_on` names it, before any derivation. `absent`: only
 * `depends_on` names it and the last derivation found no use of it in the code.
 */
export type RoleSource = "derived" | "both" | "declared" | "absent";

export function roleSource(scope: Pick<RoleScope, "derived" | "declared">, derivation: RoleDerivation | null | undefined): RoleSource {
  if (scope.derived) return scope.declared ? "both" : "derived";
  return derivation === null || derivation === undefined ? "declared" : "absent";
}

/** The tags the Source column shows for each source, the attention one last. */
export const SOURCE_TAGS: Record<RoleSource, readonly string[]> = {
  derived: ["Derived"],
  both: ["Derived", "Declared"],
  declared: ["Declared"],
  absent: ["Declared", "Not in code"],
};

/** The source filters of a table, in order; null shows every row. */
export const SOURCE_FILTERS: readonly { readonly key: RoleSource | "declaredAny" | null; readonly label: string }[] = [
  { key: null, label: "All" },
  { key: "derived", label: "Derived" },
  { key: "declaredAny", label: "Declared" },
  { key: "absent", label: "Not in code" },
];

export type SourceFilter = (typeof SOURCE_FILTERS)[number]["key"];

/** Whether a row with `source` passes `filter`: Derived holds every derived row, Declared every declared one. */
export function sourceMatches(source: RoleSource, filter: SourceFilter): boolean {
  if (filter === null) return true;
  if (filter === "derived") return source === "derived" || source === "both";
  if (filter === "declaredAny") return source !== "derived";
  return source === filter;
}

export type RoleSortKey = "scope" | "owner" | "calls" | "source" | "updated";

export interface RoleSort {
  readonly key: RoleSortKey;
  readonly descending: boolean;
}

/** A table opens ranked by call sites, as the team view ranks its pills. */
export const DEFAULT_SORT: RoleSort = { key: "calls", descending: true };

const SOURCE_ORDER: Record<RoleSource, number> = { both: 0, derived: 1, declared: 2, absent: 3 };

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The table's rows filtered by `query` (scope name, id, DRI or team) and `filter`, then sorted. */
export function roleRows(
  scopes: readonly RoleScope[],
  derivation: RoleDerivation | null | undefined,
  query: string,
  filter: SourceFilter,
  sort: RoleSort,
): RoleScope[] {
  const needle = query.trim().toLowerCase();
  const shown = scopes.filter(
    (scope) =>
      sourceMatches(roleSource(scope, derivation), filter) &&
      (needle === "" || [scope.name, scope.id, scope.ownerId, scope.teamId ?? ""].some((field) => field.toLowerCase().includes(needle))),
  );
  const compare = (a: RoleScope, b: RoleScope): number => {
    switch (sort.key) {
      case "scope":
        return text(a.name, b.name);
      case "owner":
        return text(a.ownerId, b.ownerId);
      case "calls":
        return a.calls - b.calls || a.uses - b.uses;
      case "source":
        return SOURCE_ORDER[roleSource(a, derivation)] - SOURCE_ORDER[roleSource(b, derivation)];
      case "updated":
        return text(a.updatedAt ?? "", b.updatedAt ?? "");
    }
  };
  // Ties keep the rank by call sites, then the name.
  return shown.sort((a, b) => (sort.descending ? -compare(a, b) : compare(a, b)) || b.calls - a.calls || text(a.name, b.name));
}

/** The next sort after a click on `key`'s header: the same column flips, another opens descending except text columns. */
export function nextSort(current: RoleSort, key: RoleSortKey): RoleSort {
  if (current.key === key) return { key, descending: !current.descending };
  return { key, descending: key === "calls" || key === "updated" };
}
