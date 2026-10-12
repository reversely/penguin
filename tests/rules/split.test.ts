// PRD 0.5 section 4.2 step 1: Penguin sorts each contract-diff entry. An incompatible entry with
// callers outside the author's scopes splits the feature; a behaviour change keeps the merge plan;
// additive and compatible entries need nothing more.

import assert from "node:assert/strict";
import test from "node:test";

import { sortContractDiff, type ImpactReport } from "@penguin/protocol";

type Change = ImpactReport["changes"][number];
type Use = ImpactReport["headUses"][number];
type Signature = ImpactReport["signatures"][number];

function report(changes: Change[], uses: Use[] = [], signatures: Signature[] = []): ImpactReport {
  return {
    schemaVersion: 1,
    tool: "python-impact",
    commandId: "analysis:python-impact",
    base: "a".repeat(40),
    head: "b".repeat(40),
    changes,
    signatures,
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: uses,
    forks: [],
    complete: true,
  } as unknown as ImpactReport;
}

const change = (symbol: string, kind: Change["change"], extra: Partial<Change> = {}): Change =>
  ({ symbol, path: "shared/money.py", line: 1, kind: "function", change: kind, scope: "money", contract: null, ...extra }) as Change;

const callFrom = (symbol: string, scope: string): Use => ({ path: `${scope}/a.py`, line: 3, kind: "call", symbol, name: symbol.split(".").pop() as string, scope }) as Use;

const OWN = new Set(["money"]);

test("a new symbol is additive and asks for nothing", () => {
  const sorted = sortContractDiff(report([change("shared.money.Money", "added")]), OWN);
  assert.equal(sorted.entries[0]?.sort, "additive");
  assert.equal(sorted.decision, "none");
});

test("removing a symbol that another scope calls splits the feature", () => {
  const sorted = sortContractDiff(report([change("shared.money.display", "removed")], [callFrom("shared.money.display", "tax")]), OWN);
  assert.equal(sorted.entries[0]?.sort, "incompatible");
  assert.equal(sorted.decision, "split");
});

test("removing a symbol only the author's own scopes call is compatible", () => {
  const sorted = sortContractDiff(report([change("shared.money.display", "removed")], [callFrom("shared.money.display", "money")]), OWN);
  assert.equal(sorted.entries[0]?.sort, "compatible");
  assert.equal(sorted.decision, "none");
});

test("a rename whose old name is kept as an alias is compatible", () => {
  const renamed = change("shared.money.price", "renamed", { to: { symbol: "shared.money.price_of", path: "shared/money.py", line: 9 }, kept: true });
  const sorted = sortContractDiff(report([renamed], [callFrom("shared.money.price", "tax")]), OWN);
  assert.equal(sorted.entries[0]?.sort, "compatible");
});

test("a body change to a declared contract with the same signature keeps the merge plan", () => {
  const sorted = sortContractDiff(report([change("shared.dates.start_of_day", "modified", { contract: "shared/dates.py::start_of_day", scope: "dates" })], [callFrom("shared.dates.start_of_day", "analytics")]), new Set(["dates"]));
  assert.equal(sorted.entries[0]?.sort, "behaviour");
  assert.equal(sorted.decision, "plan");
});

test("a new required parameter breaks callers and splits the feature", () => {
  const signature = { symbol: "shared.money.price", path: "shared/money.py", line: 4, before: "(amount)", after: "(amount, currency)", added: [{ name: "currency", required: true }], removed: [], breaking: true, reasons: ["adds required parameter currency"] } as Signature;
  const sorted = sortContractDiff(report([change("shared.money.price", "modified")], [callFrom("shared.money.price", "checkout")], [signature]), OWN);
  assert.equal(sorted.entries[0]?.sort, "incompatible");
  assert.equal(sorted.entries[0]?.breaks, "signature");
});

test("a new parameter with a default keeps every call working", () => {
  const signature = { symbol: "shared.money.price", path: "shared/money.py", line: 4, before: "(amount)", after: "(amount, currency='USD')", added: [{ name: "currency", required: false }], removed: [], breaking: false, reasons: [] } as Signature;
  const sorted = sortContractDiff(report([change("shared.money.price", "modified")], [callFrom("shared.money.price", "checkout")], [signature]), OWN);
  assert.equal(sorted.entries[0]?.sort, "compatible");
});
