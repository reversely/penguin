// The PRD 0.4 views (team, feature page, approvals inbox): their pure rules, and that every string
// from a record, a commit, a docstring, a form or a person renders as text. Markup, script tags and a
// long unbroken string go through every field each view prints.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BlockCheck, PlanPartRequest } from "@penguin/protocol";

import { checksByTool, exceptionText, partNumber, placeText, planGroups, recordLabel, stateClass } from "../src/feature-view.ts";
import { load } from "./render.ts";

const MARKUP = '<img src=x onerror="globalThis.pwned = 1">';
const SCRIPT = "<script>globalThis.pwned = 2</script>";
const UNBROKEN = "x".repeat(400);
const LEAKS = /<img|<script|<b>|<i>|<em>|<s>|onerror="/;

test("a feature's state takes a neutral tag and only the attention edge marks an exception", () => {
  assert.equal(stateClass("waiting on approvals"), "feature-state feature-state-waiting-on-approvals");
  assert.equal(partNumber("money-minor-units/v1#9"), "#9");
  assert.equal(placeText({ kind: "scope", scope: "tax" }), "scope tax");
  assert.equal(placeText({ kind: "feature", feature: "tax-exempt" }), "feature tax-exempt");
  assert.equal(exceptionText({ kind: "plan_returned", behavioural: 31, breakLimit: 10 }), "Plan returned: 31 behavioural parts over the limit of 10");
  assert.equal(exceptionText({ kind: "protected_difference", scope: "analytics", invariant: "tablet", differing: 2 }), "2 inputs differ on protected tablet");
  assert.equal(recordLabel("approve_plan_part"), "Part approved");
  assert.equal(recordLabel("some_later_type"), "some_later_type");
});

test("block checks group by the tool that ran them, with its version, and count each tool's failures", () => {
  const check = (target: string, name: BlockCheck["check"], tool: string, version: string | null, commandId: string, result: BlockCheck["result"]): BlockCheck => ({
    planId: null,
    target,
    check: name,
    result,
    tool: { name: tool, version, commandId },
    input: { origin: "a".repeat(40), target: "b".repeat(40), merged: null, paths: null },
    findings: [],
    findingCount: 0,
    summary: "",
    fingerprint: null,
    logRef: null,
    durationMs: 1,
  });
  const groups = checksByTool([
    check("main", "typecheck", "pyright", "1.1.414", "check:pyright", "passed"),
    check("main", "tests", "test", null, "test:tax", "passed"),
    check("tax-exempt", "typecheck", "pyright", "1.1.414", "check:pyright", "failed"),
    check("tax-exempt", "tests", "test", null, "test:tax", "error"),
  ]);
  assert.deepEqual(
    groups.map(({ tool, commandId, checks, failing }) => [tool, commandId, checks.map((each) => each.target), failing]),
    [
      ["pyright 1.1.414", "check:pyright", ["main", "tax-exempt"], 1],
      ["test", "test:tax", ["main", "tax-exempt"], 1],
    ],
  );
});

/** A review whose every string carries markup. */
const REVIEW = {
  reviewId: 4,
  feature: "money",
  scope: `<b>tax</b>`,
  reviewer: `@rahul/<i>deposits</i>`,
  state: "accepted",
  checkpoint: "a".repeat(40),
  rows: [{ invariant: "tax-per-line", statement: MARKUP, protected: true, verdict: "breaks", evidence: [SCRIPT, UNBROKEN], storedData: `<em>${UNBROKEN}</em>` }],
  storedDataMarker: { kind: "migration", evidence: MARKUP },
  riskyInputs: [],
  refusals: [{ code: "evidence_not_found", message: SCRIPT }],
  sideBySide: {
    tool: "side-by-side",
    commandId: "analysis:side-by-side",
    base: "b".repeat(40),
    fork: "a".repeat(40),
    totals: { inputs: 3, differing: 1, invalid: 0 },
    sets: [{ source: "examples", file: MARKUP, contract: SCRIPT, invariants: [], inputs: 3, differing: [{ name: MARKUP, args: SCRIPT, main: UNBROKEN, fork: MARKUP }], omitted: 0, invalid: 0, breakdown: { list: MARKUP, counts: [{ length: 3, inputs: 1 }] } }],
  },
  exceptions: [{ kind: "broken_invariant", invariant: MARKUP, scope: "tax" }],
};

test("markup and long strings in a team's people, scopes, features and agents render as text", async () => {
  const { render } = await load<{ render: (view: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement, Fragment } from "react";
    import { PersonView, TeamMapView } from "./src/team-page.tsx";
    export function render(view) {
      const navigate = () => {};
      return renderToStaticMarkup(createElement(Fragment, null,
        createElement(TeamMapView, { view, navigate }),
        createElement(PersonView, { view, board: undefined, person: view.people[0].id, navigate })));
    }`);
  const scope = { id: "tax", name: MARKUP, ownerId: "<b>rahul</b>" };
  const agent = { handle: `@rahul/${SCRIPT}`, identityId: "identity-1", person: "<i>rahul</i>", online: true };
  const view = {
    people: [
      {
        id: "<s>rahul</s>",
        role: { scopes: [scope], dependents: [scope], dependencies: [] },
        features: [{ id: UNBROKEN, person: "rahul", state: "planning", exceptions: [{ kind: "broken_invariant", scope: "tax", invariant: MARKUP }], agents: [agent], openedAt: "2026-10-11T09:00:00.000Z" }],
        idleAgents: [agent],
      },
    ],
  };
  const html = render(view);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt; reported broken in tax/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, /&lt;s&gt;rahul&lt;\/s&gt;/);
  assert.ok(html.includes(UNBROKEN));
  // The agent label names the agent and its person; the handle's "@rahul/" half stays on the card.
  assert.match(html, /class="agent-label-person">&lt;i&gt;rahul&lt;\/i&gt;</);
  assert.doesNotMatch(html, /@rahul\//);
  assert.match(html, /data-exception="true"/);
  assert.doesNotMatch(html, LEAKS);
});

test("markup in a feature page's declaration, plan, review, checks, tools and record renders as text", async () => {
  const { render } = await load<{ render: (page: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { FeatureView } from "./src/feature-page.tsx";
    export function render(page) {
      return renderToStaticMarkup(createElement(FeatureView, { page, navigate() {} }));
    }`);
  const check = {
    planId: null,
    target: "tax-exempt",
    check: "tests",
    result: "failed",
    tool: { name: "test", version: null, commandId: "test:tax" },
    input: { origin: "a".repeat(40), target: "b".repeat(40), merged: null, paths: null },
    findings: [{ path: MARKUP, line: 3, code: null, message: SCRIPT }],
    findingCount: 1,
    summary: MARKUP,
    fingerprint: null,
    logRef: null,
    durationMs: 1,
  };
  const run = {
    id: 1,
    tool: "check",
    caller: "@ines/money",
    result: "found",
    summary: SCRIPT,
    createdAt: "2026-10-11T09:00:00.000Z",
    completedAt: null,
    durationMs: 1,
    impact: { tool: "python-impact", commandId: "analysis:python-impact", contracts: [], changes: [{ symbol: MARKUP, change: "modified", path: UNBROKEN, line: 1 }], forks: [{ id: "<b>f</b>", uses: 2 }] },
    checks: [check],
    decisions: [{ target: "tax-exempt", check: "tests", step: 5, nextStep: MARKUP, actor: "@rahul/deposits" }],
    fix: null,
  };
  const page = {
    feature: { id: "money", person: "<b>ines</b>", repo: "feature-money", state: "waiting on approvals", openedAt: "2026-10-11T09:00:00.000Z", latestCheckpoint: "a".repeat(40), area: { scopes: [{ id: "money", name: MARKUP, ownerId: "ines" }], paths: [UNBROKEN], contracts: [SCRIPT] } },
    agents: [{ handle: "@ines/money", identityId: null, person: "ines", online: true }],
    waitingOn: [{ feature: "rounding", person: "<i>hugo</i>", state: "open", approvedBy: null, overlap: { scopes: [], paths: [], contracts: [] } }],
    dependents: [{ feature: "tax-exempt", person: "rahul", consumerScope: MARKUP, providerScope: "money" }],
    plan: {
      planId: "money/v1",
      version: 1,
      proposedBy: "@ines/money",
      proposedAt: "2026-10-11T09:00:00.000Z",
      breakLimit: 10,
      roundLimit: 3,
      change: { subject: SCRIPT, madeBy: "@ines/money", checkpoint: "a".repeat(40) },
      sources: [{ fact: "contract_diff", tool: "analysis:python-impact", detail: MARKUP }],
      contractDiff: { complete: true, contracts: [], changes: [{ symbol: MARKUP, kind: "function", change: "modified", path: "shared/money.py", line: 1 }], signatures: [{ symbol: "price", before: SCRIPT, after: MARKUP, breaking: true }], dataShapes: [] },
      mainCallers: [{ path: MARKUP, line: 1, kind: "call", symbol: "price", name: "price", scope: "tax" }],
      affectedFeatures: [],
      parts: [
        {
          partId: "money/v1#1",
          revision: 1,
          place: { kind: "scope", scope: "<b>tax</b>" },
          owner: "rahul",
          scopes: ["tax"],
          kind: "behavioural",
          kindReason: MARKUP,
          state: "pending",
          approvedBy: null,
          changeRequests: 1,
          changeRequest: { by: "rahul", revision: 1, text: SCRIPT },
          callers: [],
          breaks: [{ target: "main", statement: MARKUP, nodeId: UNBROKEN, assertion: SCRIPT, error: MARKUP }],
          invariants: [{ scopeId: "tax", id: "tax-per-line", statement: MARKUP, protected: true }],
          note: null,
          files: null,
        },
      ],
    },
    reviews: [REVIEW],
    fixes: [{ partId: "money/v1#2", feature: "<b>tax-exempt</b>", person: "rahul", state: "approved", revision: 1, write: { state: "written", writer: "agent", commit: "c".repeat(40), rebased: false } }],
    checks: run,
    tools: [run],
    records: [{ recordId: "r1", type: MARKUP, author: SCRIPT, createdAt: "2026-10-11T09:00:00.000Z", path: UNBROKEN }],
  };
  const html = render(page);
  for (const text of ["&lt;script&gt;globalThis.pwned = 2&lt;/script&gt;", "&lt;b&gt;ines&lt;/b&gt;", "&lt;i&gt;hugo&lt;/i&gt;", "&lt;b&gt;tax-exempt&lt;/b&gt;", UNBROKEN]) {
    assert.ok(html.includes(text), text);
  }
  // A fix written into another fork names its writer and the commit.
  assert.match(html, /written<\/span><span class="muted">by the originating agent<\/span><code>cccccccccccc<\/code>/);
  // Each tool shows by name beside what it reported.
  assert.match(html, /class="tool-name">analysis:python-impact</);
  assert.match(html, /class="tool-name">side-by-side</);
  assert.match(html, /class="tool-name">test</);
  // Each part's facts and lines stay closed behind a line counting them until the reader opens it.
  assert.match(html, /1 break, 1 invariant, 0 uses<\/summary>/);
  // No page prints a session transcript; the feature page has no field for one.
  assert.doesNotMatch(html, /transcript/i);
  assert.doesNotMatch(html, LEAKS);
});

test("markup in an approval's overlap, part, breaks, review, changed lines and returned plan renders as text", async () => {
  const { render, renderDiff } = await load<{ render: (approvals: unknown) => string; renderDiff: (files: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { ApprovalsView } from "./src/approvals.tsx";
    import { DiffFiles } from "./src/review-card.tsx";
    export const renderDiff = (files) => renderToStaticMarkup(createElement(DiffFiles, { files }));
    export function render(approvals) {
      const noop = () => {};
      return renderToStaticMarkup(createElement(ApprovalsView, { approvals, busy: undefined, failed: false, navigate: noop, onApproveStart: noop, onDecide: noop }));
    }`);
  const part = {
    ask: "approve",
    feature: "money",
    person: "ines",
    partId: "money/v1#2",
    revision: 2,
    place: { kind: "feature", feature: "tax-exempt" },
    owner: "rahul",
    kind: "behavioural",
    kindReason: SCRIPT,
    state: "pending",
    changeRequests: 1,
    roundLimit: 3,
    files: [{ path: MARKUP, status: "modified", lines: [`+total = ${MARKUP}`, `-${UNBROKEN}`] }],
    breaks: [{ target: "tax-exempt", statement: MARKUP, nodeId: "tax/tests/test_x.py::test_x", assertion: null, error: SCRIPT }],
    reviews: [REVIEW],
    routing: { inPerson: true, reasons: [{ kind: "broken_invariant", scope: "tax", invariant: MARKUP, reviewId: 4 }] },
    changeRequest: { by: "rahul", revision: 1, text: SCRIPT },
    read: false,
    raisedAt: "2026-10-11T09:00:00.000Z",
  };
  const approvals = {
    overlaps: [{ feature: "rounding", blockedFeature: "money", blockedPerson: "ines", overlap: { scopes: [MARKUP], paths: [UNBROKEN], contracts: [SCRIPT], omittedPaths: 2 }, read: false, raisedAt: "2026-10-11T09:00:00.000Z" }],
    plan: {
      parts: [part, { ...part, ask: "round_limit", state: "round_limit", partId: "money/v1#3" }],
      reviewExceptions: [{ feature: "money", scope: "tax", reviewId: 4, state: "accepted", exceptions: REVIEW.exceptions, review: REVIEW, read: false, raisedAt: "2026-10-11T09:00:00.000Z" }],
      returnedPlans: [{ feature: "money", breakLimit: 10, behavioural: [MARKUP], read: false, raisedAt: "2026-10-11T09:00:00.000Z" }],
    },
  };
  const html = render(approvals);
  assert.match(html, /The review reports &lt;img/);
  // A part's changed lines open from its counting line; they render as text there too.
  assert.match(renderDiff(part.files), /\+total = &lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;/);
  assert.ok(html.includes(UNBROKEN));
  for (const heading of ["Overlapping starts", "Plans", "Review exceptions", "Returned plans"]) assert.ok(html.includes(heading), heading);
  // Only the part waiting on the person and the overlapping start carry controls; the round-limit part shows none.
  assert.equal(html.match(/Approve revision 2/g)?.length, 1);
  assert.equal(html.match(/Approve start/g)?.length, 1);
  // Both parts belong to one plan: one card, the shared review and its reason once, both parts listed.
  assert.equal(html.match(/class="approval-card card-raised plan-card"/g)?.length, 1);
  assert.equal(html.match(/<h4 class="review-title">/g)?.length, 1);
  assert.equal(html.match(/The review reports/g)?.length, 1);
  assert.equal(html.match(/class="plan-part"/g)?.length, 2);
  assert.match(html, /Past the round limit/);
  // The review exception names the same review, so it links to the card above instead of repeating it.
  assert.match(html, /<a class="review-link" href="#review-4">Review of tax<\/a>/);
  // A part's breaks and lines stay closed behind a line counting them.
  assert.match(html, /1 break, 1 changed file<\/summary>/);
  assert.doesNotMatch(html, LEAKS);
});

test("a long side-by-side set shows its count, its breakdown and three examples, with the full table one press away", async () => {
  const { render } = await load<{ render: (review: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { ReviewCard } from "./src/review-card.tsx";
    export function render(review) {
      return renderToStaticMarkup(createElement(ReviewCard, { review }));
    }`);
  const differing = Array.from({ length: 5 }, (_, index) => ({ name: `order-000${index}`, args: "{}", main: "36", fork: "35" }));
  const set = { ...REVIEW.sideBySide.sets[0], file: "tax/examples/invoice_tax.json", inputs: 5000, differing, omitted: 1628, breakdown: { list: "lines", counts: [{ length: 3, inputs: 600 }, { length: 4, inputs: 1033 }] } };
  const html = render({ ...REVIEW, sideBySide: { ...REVIEW.sideBySide, totals: { inputs: 5000, differing: 1633, invalid: 0 }, sets: [set] } });
  assert.match(html, /1,633 of 5,000 inputs differ between main/);
  assert.match(html, /on tax\/examples\/invoice_tax\.json: 1,633 of 5,000 differ/);
  assert.match(html, /<th scope="row">lines<\/th><td>3<\/td><td>4<\/td><\/tr><tr><th scope="row">differ<\/th><td>600<\/td><td>1,033<\/td>/);
  assert.equal(html.match(/class="sbs-difference"/g)?.length, 3);
  assert.match(html, /aria-expanded="false"[^>]*>.*All 1,633 differing inputs<\/button>/);
  // A short set lists every differing input and offers no table.
  const short = render(REVIEW);
  assert.equal(short.match(/class="sbs-difference"/g)?.length, 1);
  assert.doesNotMatch(short, /differing inputs<\/button>/);
});

test("a person's plan parts group by plan with each shared review and reason once", () => {
  const part = (partId: string, reviewIds: number[], read = true) =>
    ({
      ask: "approve",
      feature: partId.split("/")[0],
      person: "ines",
      partId,
      reviews: reviewIds.map((reviewId) => ({ ...REVIEW, reviewId })),
      routing: { inPerson: true, reasons: [{ kind: "broken_invariant", scope: "tax", invariant: "tax-per-line", reviewId: 4 }] },
      read,
    }) as unknown as PlanPartRequest;
  const groups = planGroups([part("money/v1#7", [4]), part("refunds/v2#1", []), part("money/v1#21", [4, 5], false), part("money/v1#22", [4])]);
  assert.deepEqual(
    groups.map((group) => [group.planId, group.feature, group.parts.map((each) => partNumber(each.partId)), group.reviews.map((review) => review.reviewId), group.reasons, group.unread]),
    [
      ["money/v1", "money", ["#7", "#21", "#22"], [4, 5], ["The review reports tax-per-line broken in tax"], true],
      ["refunds/v2", "refunds", ["#1"], [], ["The review reports tax-per-line broken in tax"], false],
    ],
  );
});
