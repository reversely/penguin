import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evidencePaths,
  evidenceProblem,
  parseEvidence,
  parseExampleFile,
  parseReviewForm,
  REVIEW_LIMITS,
  reviewExceptions,
  validateReviewForm,
  type InvariantView,
  type ReviewForm,
  type SideBySideRecord,
} from "@penguin/protocol";

// The rounding exit check of PRD 0.4 Phase D, as the tax scope of docs/case-study-money.md.
const PER_LINE: InvariantView = { id: "tax-per-line", scopeId: "tax", statement: "Tax is rounded per line item", protected: true };
const NON_NEGATIVE: InvariantView = { id: "tax-non-negative", scopeId: "tax", statement: "Tax is never negative", protected: false };
const INVARIANTS = [PER_LINE, NON_NEGATIVE];

const TEST_FILE = [
  "from tax.invoice import invoice_tax",
  "",
  "",
  "def test_tax_is_rounded_per_line():",
  "    assert invoice_tax([]) == 0",
  "",
  "",
  "class TestRefunds:",
  "    def test_refund_tax_is_never_negative(self):",
  "        pass",
  "",
].join("\n");
const CODE_FILE = ["def invoice_tax(lines):", "    return sum(round(line) for line in lines)", ""].join("\n");
const FILES = new Map<string, string | null>([
  ["tax/tests/test_invoice.py", TEST_FILE],
  ["tax/invoice.py", CODE_FILE],
  ["tax/missing.py", null],
]);

const form = (rows: ReviewForm["rows"], extra: Partial<ReviewForm> = {}): ReviewForm => ({
  rows,
  riskyInputs: [],
  storedDataMarker: null,
  ...extra,
});
const row = (invariant: string, verdict: "holds" | "breaks" | "unknown", evidence: string[]) => ({
  invariant,
  verdict,
  evidence,
  storedData: "Invoices issued before the change keep their tax",
});
const codes = (value: ReviewForm, storedShapes: { symbol: string; path: string }[] | null = null) =>
  validateReviewForm({ form: value, invariants: INVARIANTS, files: FILES, storedShapes }).refusals.map((refusal) => [
    refusal.code,
    refusal.invariant ?? refusal.evidence ?? null,
  ]);

const NEGATIVE_TEST = "tax/tests/test_invoice.py::TestRefunds::test_refund_tax_is_never_negative";

test("a rounding change is refused at review until the form cites a test", () => {
  const breaksNoTest = form([row("tax-per-line", "unknown", ["tax/invoice.py:2"]), row("tax-non-negative", "holds", [NEGATIVE_TEST])]);
  assert.deepEqual(codes(breaksNoTest), [["unknown_without_test", "tax-per-line"]]);
  const cited = form([
    row("tax-per-line", "unknown", ["tax/invoice.py:2", "tax/tests/test_invoice.py::test_tax_is_rounded_per_line"]),
    row("tax-non-negative", "holds", [NEGATIVE_TEST]),
  ]);
  assert.deepEqual(codes(cited), []);
});

test("each refusal names its reason: missing row, unknown or repeated invariant, no evidence", () => {
  assert.deepEqual(codes(form([row("tax-per-line", "holds", ["tax/invoice.py:1"])])), [["missing_row", "tax-non-negative"]]);
  assert.deepEqual(
    codes(
      form([
        row("tax-per-line", "holds", []),
        row("tax-per-line", "holds", ["tax/invoice.py:1"]),
        row("tax-non-negative", "breaks", ["tax/invoice.py::invoice_tax"]),
        row("shipping-free", "holds", ["tax/invoice.py:1"]),
      ]),
    ),
    [
      ["no_evidence", "tax-per-line"],
      ["duplicate_row", "tax-per-line"],
      ["unknown_invariant", "shipping-free"],
    ],
  );
});

test("evidence must exist in the fork: the file, the definition and the line", () => {
  const refused = codes(
    form([
      row("tax-per-line", "holds", ["tax/missing.py:1", "tax/invoice.py:4", "tax/invoice.py::no_such_function"]),
      // A method named at the top level is not the method inside its class.
      row("tax-non-negative", "holds", ["tax/tests/test_invoice.py::test_refund_tax_is_never_negative"]),
    ]),
  );
  assert.deepEqual(refused, [
    ["evidence_not_found", "tax-per-line"],
    ["evidence_not_found", "tax-per-line"],
    ["evidence_not_found", "tax-per-line"],
    ["evidence_not_found", "tax-non-negative"],
  ]);
});

test("evidence paths stay inside the fork and evidence is never read as anything but a name", () => {
  for (const hostile of ["../secrets.py:1", "/etc/passwd:1", "tax/../../x.py::f", "tax/invoice.py::f; rm -rf /", "-rf:1", "tax/invoice.py:0", "tax/invoice.py"]) {
    assert.equal(parseEvidence(hostile), undefined, hostile);
  }
  assert.deepEqual(parseEvidence("tax/tests/test_invoice.py::TestRefunds::test_refund_tax_is_never_negative"), {
    kind: "symbol",
    path: "tax/tests/test_invoice.py",
    names: ["TestRefunds", "test_refund_tax_is_never_negative"],
    test: true,
  });
  assert.equal((parseEvidence("tax/invoice.py::invoice_tax") as { test: boolean }).test, false);
  assert.equal(evidenceProblem({ kind: "line", path: "tax/invoice.py", line: 2 }, CODE_FILE), null);
  assert.deepEqual(
    evidencePaths(form([row("tax-per-line", "holds", ["../x:1", "tax/invoice.py:1", "tax/invoice.py:2"])], { storedDataMarker: { kind: "cutover", evidence: "tax/cutover.py:1" } })),
    ["tax/cutover.py", "tax/invoice.py"],
  );
});

test("a stored shape change without a migration, backfill or cutover marker is refused", () => {
  const rows = [row("tax-per-line", "holds", ["tax/invoice.py:1"]), row("tax-non-negative", "holds", ["tax/invoice.py:1"])];
  const shapes = [{ symbol: "tax.invoice.Line", path: "tax/invoice.py" }];
  assert.deepEqual(codes(form(rows), shapes), [["stored_data_without_marker", null]]);
  assert.deepEqual(codes(form(rows, { storedDataMarker: { kind: "backfill", evidence: "tax/invoice.py:1" } }), shapes), []);
  assert.deepEqual(codes(form(rows, { storedDataMarker: { kind: "migration", evidence: "tax/missing.py:1" } }), shapes), [
    ["evidence_not_found", "tax/missing.py:1"],
  ]);
  const unknownDiff = validateReviewForm({ form: form(rows), invariants: INVARIANTS, files: FILES, storedShapes: null });
  assert.equal(unknownDiff.accepted, true);
  assert.equal(unknownDiff.storedDataChecked, false);
});

test("the form's shape and limits are checked before its content", () => {
  const long = "x".repeat(REVIEW_LIMITS.evidenceLength + 1);
  const parsed = parseReviewForm({ rows: [{ invariant: "tax-per-line", verdict: "fine", evidence: [long], storedData: "" }], extra: 1 });
  assert.equal(parsed.ok, false);
  const messages = parsed.ok ? [] : parsed.refusals.map((refusal) => refusal.message);
  assert.ok(messages.some((message) => /verdict must be one of/.test(message)));
  assert.ok(messages.some((message) => /evidence\/0 must be at most/.test(message)));
  assert.ok(messages.some((message) => /extra/.test(message)));

  let deep: unknown = 1;
  for (let i = 0; i < REVIEW_LIMITS.argsDepth + 1; i += 1) deep = [deep];
  const nested = parseReviewForm({ rows: [], riskyInputs: [{ name: "deep", contract: "tax/invoice.py::invoice_tax", args: { lines: deep } }] });
  assert.equal(nested.ok, false);
  const shell = parseReviewForm({ rows: [], riskyInputs: [{ name: "$(reboot)", contract: "tax/invoice.py::invoice_tax", args: {} }] });
  assert.equal(shell.ok, false);
  assert.deepEqual(parseReviewForm({ rows: [] }), { ok: true, form: { rows: [], riskyInputs: [], storedDataMarker: null } });
});

test("a broken invariant and a difference on a protected invariant route to the scope's owner", () => {
  const set = (invariants: string[], differing: number) => ({
    source: "examples" as const,
    file: "tax/examples/orders.json",
    contract: "tax/invoice.py::invoice_tax",
    invariants,
    inputs: [],
    differing: Array.from({ length: differing }, (_, n) => ({
      name: `order ${n}`,
      args: {},
      main: { status: "returned" as const, value: 1 },
      fork: { status: "returned" as const, value: 2 },
    })),
    invalid: [],
    mainMs: 0,
    forkMs: 0,
  });
  const record = { sets: [set(["tax-per-line"], 312), set(["tax-non-negative"], 4), set(["tax-per-line"], 0)] } as unknown as SideBySideRecord;
  const reviewed = form([row("tax-per-line", "holds", []), row("tax-non-negative", "breaks", [])]);
  assert.deepEqual(reviewExceptions(reviewed, INVARIANTS, record), [
    { kind: "broken_invariant", invariant: "tax-non-negative", scope: "tax" },
    { kind: "protected_difference", invariant: "tax-per-line", scope: "tax", contract: "tax/invoice.py::invoice_tax", differing: 312 },
  ]);
  // A refused form goes back to its agent; the protected difference still reaches the owner.
  assert.deepEqual(reviewExceptions(null, INVARIANTS, record).map((exception) => exception.kind), ["protected_difference"]);
});

test("an examples file is a contract and named cases of keyword arguments", () => {
  const file = parseExampleFile({ contract: "tax/invoice.py::invoice_tax", cases: [{ name: "three lines", args: { lines: [1, 2, 3] } }] });
  assert.equal(file.cases.length, 1);
  assert.throws(() => parseExampleFile({ contract: "x.py::f", cases: [{ name: "a", args: {} }, { name: "a", args: {} }] }), /unique/);
  assert.throws(() => parseExampleFile({ contract: "x.py::f", cases: [{ name: "a", args: [] }] }), /object/);
});
