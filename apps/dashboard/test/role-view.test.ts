// The person page's role tables (#134, #136): every scope the person owns, reads and is read by,
// in tables that sort and filter.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PersonRole, RoleDerivation, RoleScope } from "@penguin/protocol";

import { DEFAULT_SORT, nextSort, roleCount, roleRows, roleSource, sourceMatches } from "../src/role-view.ts";
import { load } from "./render.ts";

const DERIVED: RoleDerivation = { promotion: "c".repeat(40), derivedAt: "2026-10-11T09:00:00.000Z", complete: true };

function scope(id: string, owner: string, calls: number, fields: Partial<RoleScope> = {}): RoleScope {
  return {
    id,
    name: id[0]?.toUpperCase() + id.slice(1),
    ownerId: owner,
    teamId: `person:${owner}`,
    fallbackIds: [],
    calls,
    uses: calls + 1,
    derived: calls > 0,
    declared: false,
    via: ["money"],
    updatedPromotion: DERIVED.promotion,
    updatedAt: DERIVED.derivedAt,
    ...fields,
  };
}

const reads = [
  scope("tax", "rahul", 4, { declared: true }),
  scope("orders", "tomas", 9),
  scope("reports", "jun", 0, { declared: true, updatedAt: "2026-10-01T09:00:00.000Z" }),
  scope("payouts", "ana", 2),
];

test("a dependency's source: derived, both, declared before any derivation, and declared but absent from the code", () => {
  assert.equal(roleSource(reads[1] as RoleScope, DERIVED), "derived");
  assert.equal(roleSource(reads[0] as RoleScope, DERIVED), "both");
  assert.equal(roleSource(reads[2] as RoleScope, DERIVED), "absent");
  assert.equal(roleSource(reads[2] as RoleScope, null), "declared");
  // Declared holds every declared row; Derived every row the code shows.
  assert.deepEqual(["derived", "both", "declared", "absent"].map((source) => sourceMatches(source as never, "declaredAny")), [false, true, true, true]);
  assert.deepEqual(["derived", "both", "declared", "absent"].map((source) => sourceMatches(source as never, "derived")), [true, true, false, false]);
});

test("a table opens ranked by call sites, sorts by any column and filters by text and source", () => {
  const ids = (rows: readonly RoleScope[]) => rows.map((row) => row.id);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", null, DEFAULT_SORT)), ["orders", "tax", "payouts", "reports"]);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", null, { key: "scope", descending: false })), ["orders", "payouts", "reports", "tax"]);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", null, { key: "owner", descending: false })), ["payouts", "reports", "tax", "orders"]);
  // Derived and declared first, then derived, then declared only; ties by call sites.
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", null, { key: "source", descending: false })), ["tax", "orders", "payouts", "reports"]);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", null, { key: "updated", descending: true })), ["orders", "tax", "payouts", "reports"]);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "RAH", null, DEFAULT_SORT)), ["tax"]);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", "absent", DEFAULT_SORT)), ["reports"]);
  assert.deepEqual(ids(roleRows(reads, DERIVED, "", "derived", DEFAULT_SORT)), ["orders", "tax", "payouts"]);
  // A click flips the open column; another column opens descending for numbers and dates only.
  assert.deepEqual(nextSort(DEFAULT_SORT, "calls"), { key: "calls", descending: false });
  assert.deepEqual(nextSort(DEFAULT_SORT, "scope"), { key: "scope", descending: false });
  assert.deepEqual(nextSort(DEFAULT_SORT, "updated"), { key: "updated", descending: true });
});

test("a role row counts from `counts`, or from its list for an older Worker", () => {
  const role: PersonRole = { scopes: [], dependents: [], dependencies: reads.slice(0, 3), counts: { owns: 3, reads: 12, readBy: 27 } };
  assert.deepEqual([roleCount(role, "owns"), roleCount(role, "reads"), roleCount(role, "readBy")], [3, 12, 27]);
  assert.equal(roleCount({ scopes: [], dependents: [], dependencies: reads }, "reads"), 4);
});

test("the person page lists every scope; Updated shows only where it differs from main's commit and via only where rows run through several own scopes", async () => {
  const { person } = await load<{ person: (role: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { PersonView } from "./src/person-page.tsx";
    export function person(role) {
      const view = { people: [{ id: "ines", role, features: [], idleAgents: [] }] };
      return renderToStaticMarkup(createElement(PersonView, { view, board: undefined, person: "ines", navigate() {}, scopes: { person: "ines", role } }));
    }`);
  const owns = [scope("money", "ines", 13, { declared: true, via: [] }), scope("ledger", "ines", 1, { declared: true, via: [] }), scope("fx", "ines", 0, { declared: true, via: [] })];
  // Reports reads Ines's ledger; the rest read her money scope.
  const dependents = reads.map((each) => (each.id === "reports" ? { ...each, via: ["ledger"] } : each));
  const full: PersonRole = { scopes: owns, dependents, dependencies: [], counts: { owns: 3, reads: 0, readBy: 4 }, derivation: DERIVED };
  const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  const page = person(full);
  assert.match(text(page), /Read from main at cccccccccccc/u);
  // Every row's counts changed at the commit the page reads, so no table shows Updated.
  assert.match(text(page), /Read by 4 Scope DRI Call sites Source Orders/u);
  assert.doesNotMatch(text(page), /Updated/u);
  // The rows run through two of Ines's three scopes, so each row names the one it runs through.
  assert.match(text(page), /Orders via Money T tomas 9 Derived/u);
  assert.match(text(page), /Reports via Ledger J jun 0 Declared Not in code/u);
  // Every row running through one own scope would repeat the same via, so none shows.
  assert.doesNotMatch(text(person({ ...full, dependents: reads })), /via/u);
  assert.match(page, /aria-sort="descending"/u);
  assert.equal(page.match(/<tr>/gu)?.length, 3 + 1 + 4 + 1, "a header and a line per scope in Owns and Read by");
  // With one scope of their own, every row runs through it; a row changed at an older commit names it.
  const older = { ...(reads[1] as RoleScope), updatedPromotion: "d".repeat(40) };
  const single = text(person({ ...full, scopes: owns.slice(0, 1), counts: { owns: 1, reads: 0, readBy: 4 }, dependents: [older, ...reads.slice(2)] }));
  assert.doesNotMatch(single, /via/u);
  assert.match(single, /Read by 4 Scope DRI Call sites Source Updated Orders T tomas 9 Derived dddddddddddd Payouts A ana 2 Derived Reports/u);
});
