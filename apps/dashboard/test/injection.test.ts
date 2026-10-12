import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { load } from "./render.ts";

const root = join(import.meta.dirname, "..");
const MARKUP = '<img src=x onerror="globalThis.pwned = 1">';

// React escapes every text child and attribute value, so markup from an identity name, a handle, an
// issue title or a comment can only run through one of these raw-HTML sinks.
const RAW_HTML_SINKS = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|srcdoc|\beval\(|new Function\(/;

test("no dashboard source writes raw HTML, so every user value renders as React text", async () => {
  const files = (await readdir(join(root, "src"))).filter((file) => /\.tsx?$/.test(file));
  assert.ok(files.length > 10);
  for (const file of files) {
    const source = await readFile(join(root, "src", file), "utf8");
    assert.doesNotMatch(source, RAW_HTML_SINKS, file);
  }
});

test("markup in an issue title and an assignee's or identity's handle renders as escaped text in the inbox rows", async () => {
  // The rows and the identity strip take their data as props, so they render on the server without a fetch.
  const { render } = await load<{ render: (items: unknown[], identities: unknown[]) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement, Fragment } from "react";
    import { IdentityStrip, InboxList } from "./src/inbox-page.tsx";
    export function render(items, identities) {
      const inbox = { load: { kind: "ready", items }, marking: new Set(), markFailed: false, markRead() {} };
      const facts = { issues: new Map(), identities: new Map(identities.map((identity) => [identity.handle, { ...identity, sessions: [{}] }])) };
      return renderToStaticMarkup(createElement(Fragment, null,
        createElement(IdentityStrip, { identities, facts, navigate() {} }),
        createElement(InboxList, { inbox, facts, viewer: "jun", now: new Date(), showAll: false, openIssue: "40", navigate() {} })));
    }`);
  const handle = `@jun/${MARKUP}`;
  const html = render(
    [
      { issueId: "40", reason: "assigned", read: false, raisedAt: "2026-10-11T09:00:00.000Z", title: `${MARKUP} @jun/<b>reports</b>`, state: "open", assigneeHandles: [handle] },
      { issueId: "41", reason: "start_session", read: true, raisedAt: "2026-10-11T09:01:00.000Z", title: "<script>globalThis.pwned = 2</script>", state: "open", assigneeHandles: [] },
    ],
    [{ id: "identity-1", handle, name: MARKUP, avatar: null, owners: ["jun"] }],
  );
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt; @jun\/&lt;b&gt;reports&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, />@jun\/&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt; online</, "the row names its online assignee");
  assert.match(html, /class="identity-strip-handle">@jun\/<wbr\/>&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;</);
  assert.match(html, /Waiting for you to start a session/);
  assert.doesNotMatch(html, /<img|<script|<b>|onerror="/);
});

test("markup in a handle stays an escaped attribute on a character and an initial avatar", async () => {
  const { render } = await load<{ render: (handle: string) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement, Fragment } from "react";
    import { Character, IdentityAvatar, PersonAvatar } from "./src/avatar.tsx";
    export function render(handle) {
      return renderToStaticMarkup(createElement(Fragment, null,
        createElement(Character, { handle, size: "header", label: handle }),
        createElement(IdentityAvatar, { handle, image: null, size: "row" }),
        createElement(PersonAvatar, { id: handle, size: "card" })));
    }`);
  const html = render(`@jun/${MARKUP}`);
  assert.match(html, /aria-label="@jun\/&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;"/);
  assert.match(html, /role="img"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /<img|onerror="/);
});

test("markup in an identity's handle, name, job, charter and owners renders as text in its row, detail and form", async () => {
  const { render } = await load<{ render: (identity: unknown, scopes: unknown[]) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement, Fragment } from "react";
    import { IdentityDetail, IdentityFormView, IdentityList } from "./src/identities-page.tsx";
    import { formFor } from "./src/identities-view.ts";
    export function render(identity, scopes) {
      const limits = { nameLength: 80, jobLength: 1000, rules: 32, ruleLength: 1000, scopes: 32, paths: 64, pathLength: 512, teamOwners: 16, avatarBytes: 65536 };
      const page = { identities: [identity], scopes, owners: identity.owners, limits };
      const noop = () => {};
      return renderToStaticMarkup(createElement(Fragment, null,
        createElement(IdentityList, { identities: [identity], selectedId: identity.id, onChoose: noop }),
        createElement(IdentityDetail, { identity, board: undefined, scopes, viewer: identity.owners[0], navigate: noop, onBack: noop, onEdit: noop, onDuplicate: noop }),
        createElement(IdentityFormView, { initialForm: formFor(identity, "edit", identity.owners[0], new Set()), page, viewer: identity.owners[0], onCancel: noop, onSaved: noop, onSignedOut: noop })));
    }`);
  const html = render(
    {
      id: "identity-1",
      handle: `@jun/${MARKUP}`,
      name: "<b>Reports</b>",
      avatar: null,
      job: "<script>globalThis.pwned = 2</script>",
      team: true,
      owners: ["jun", "<i>sam</i>"],
      charterScopes: ["analytics"],
      charterPaths: ["<u>analytics</u>"],
      charterRules: ["<em>rule</em>"],
      autoAccept: true,
      duplicatedFrom: null,
      sessions: [{ id: "s1", vendor: "<b>codex</b>", branch: "b", worktreeId: "wt", status: "running", currentIssueId: null, lastSeen: "2026-10-11T09:00:00.000Z" }],
      history: [],
      lastCheckpoint: null,
      recentOperations: [],
    },
    [{ id: "analytics", name: "<s>Analytics</s>", ownerId: "jun", testCommand: "<kbd>pytest</kbd>" }],
  );
  assert.match(html, /@jun\/&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;/);
  assert.match(html, /&lt;b&gt;Reports&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, />&lt;i&gt;sam&lt;\/i&gt;</);
  assert.match(html, /&lt;s&gt;Analytics&lt;\/s&gt;/);
  assert.match(html, /&lt;kbd&gt;pytest&lt;\/kbd&gt;/);
  assert.match(html, /&lt;u&gt;analytics&lt;\/u&gt;/);
  assert.match(html, /&lt;em&gt;rule&lt;\/em&gt;/);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<s>|<kbd>|<u>|<em>|onerror="/);
});

test("markup in the owner's name and an issue title renders as text in the shell's menu and details panel", async () => {
  const { render } = await load<{ render: (owner: string, title: string) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement, Fragment } from "react";
    import { AccountMenu } from "./src/account-menu.tsx";
    import { DetailsPanel } from "./src/details-pane.tsx";
    export function render(owner, title) {
      return renderToStaticMarkup(createElement(Fragment, null,
        createElement(AccountMenu, { session: { owner, login: owner }, status: "live" }),
        createElement(DetailsPanel, null, createElement("h2", null, title))));
    }`);
  const html = render(MARKUP, "<script>globalThis.pwned = 2</script>");
  assert.match(html, /title="GitHub &lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;"/);
  assert.match(html, />&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;</);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|onerror="/);
});

/** A board and an identities page whose owner, handles, title, scope and session values carry markup. */
function markedTeam() {
  const handle = `@jun/${MARKUP}`;
  const owner = `<em>${MARKUP}</em>`;
  const session = { id: "s1", vendor: "<b>codex</b>", branch: "<i>main</i>", status: "running" };
  const issue = {
    issue: {
      id: "7",
      alias: null,
      title: "<script>globalThis.pwned = 2</script>",
      body: MARKUP,
      state: "in_review",
      stateReason: null,
      labels: [],
      parentId: null,
      version: 1,
      assignees: [{ kind: "identity", id: handle, session, waitingFor: null }],
      commits: [],
      checks: [],
      reviews: [],
      threads: [{ id: "t1", status: "open", needsPersonIds: [`<kbd>${MARKUP}</kbd>`] }],
    },
    subIssues: [],
    laneOwners: { [handle]: ["jun"] },
  };
  const board = {
    owners: [
      {
        id: "jun",
        identities: [{ handle, name: `<u>${MARKUP}</u>`, avatar: null, team: false, sessions: [{ ...session, lastSeen: "2026-10-11T09:00:00.000Z" }] }],
      },
      { id: owner, identities: [{ handle: "@x/<s>idle</s>", name: "idle", avatar: null, team: true, sessions: [] }] },
    ],
    issues: [issue],
    waiting: [{ personId: "jun", issueId: "7", reason: "review_requested" }],
  };
  const identity = {
    id: "identity-1",
    handle,
    name: "<b>Reports</b>",
    avatar: null,
    job: "job",
    team: false,
    owners: ["jun"],
    charterScopes: [],
    charterPaths: [],
    charterRules: [],
    autoAccept: true,
    duplicatedFrom: null,
    sessions: [{ ...session, worktreeId: "<q>wt</q>", currentIssueId: "7", lastSeen: "2026-10-11T09:00:00.000Z" }],
    history: [],
    lastCheckpoint: { sha: "9b2f10c4e1a7d3f58b6e2c0a9d4f71e3b5c8a2d6", sessionId: "s1", reportedAt: "2026-10-11T09:00:00.000Z" }, // pragma: allowlist secret
    recentOperations: [{ seq: 3, opId: "op", issueId: "7", type: "add_label", payload: { label: "<mark>x</mark>" } }],
  };
  const page = {
    identities: [identity],
    scopes: [{ id: "analytics", name: "<s>Analytics</s>", ownerId: "jun", testCommand: "pytest" }],
    owners: ["jun", owner],
    limits: {},
  };
  return { board, page, identity };
}

test("markup in an owner, a handle, a session, an issue title and a scope renders as text on the team map and a person's view", async () => {
  const { render } = await load<{ render: (board: unknown, page: unknown, person: string) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement, Fragment } from "react";
    import { PersonView, TeamMapView } from "./src/team-page.tsx";
    export function render(board, page, person) {
      const props = { board, page, viewer: "jun", navigate() {} };
      return renderToStaticMarkup(createElement(Fragment, null,
        createElement(TeamMapView, props),
        createElement(PersonView, { ...props, person })));
    }`);
  const { board, page } = markedTeam();
  const html = render(board, page, "jun");
  assert.match(html, /@jun\/&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, /&lt;em&gt;/);
  assert.match(html, /@x\/&lt;s&gt;idle&lt;\/s&gt;/);
  assert.match(html, /&lt;s&gt;Analytics&lt;\/s&gt;/);
  assert.match(html, /1 review/);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<em>|<s>|<u>|<q>|<kbd>|onerror="/);
});

test("markup in an issue title, body, comment, thread, check, review and identity renders as text on the issue page", async () => {
  const { render } = await load<{ render: (page: unknown, handle: string) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { IssueContent } from "./src/issue-page.tsx";
    export function render(page, handle) {
      const identities = { kind: "ready", handles: [handle], known: new Map([[handle, { id: "<b>identity-1</b>", avatar: null }]]) };
      const noop = () => {};
      return renderToStaticMarkup(createElement(IssueContent, { page, viewer: "jun", identities, phone: false, navigate: noop, onSignedOut: noop, onWritten: noop }));
    }`);
  const handle = "@jun/reports";
  const entry = (opId: string, author: string, type: string, payload: unknown) => ({
    seq: 1,
    opId,
    author,
    type,
    payload,
    status: "applied",
    rejectReason: null,
    message: null,
    gitCommit: null,
    waitingForGitLog: false,
    waitedMs: null,
  });
  const html = render(
    {
      issue: {
        id: "16",
        alias: null,
        title: "<script>globalThis.pwned = 2</script>",
        body: MARKUP,
        state: "in_review",
        stateReason: null,
        labels: ["<u>scope</u>"],
        parentId: null,
        version: 9,
        assignees: [{ kind: "identity", id: handle, session: { id: "s1", vendor: "<b>codex</b>", branch: "<i>main</i>", status: "running" }, waitingFor: null }],
        commits: [],
        checks: [{ opId: "c1", commandId: "test:a", repo: "huddle-016", sha: "1a2b3c4d", test: "<em>dau</em>", result: "fail", logRef: "<s>log</s>", fingerprint: null, supersededBy: null }],
        reviews: [{ opId: "r1", reviewer: "sam", verdict: "request_changes", reason: "<q>no</q>", repo: "r", sha: "1a2b3c", counts: false, uncountedReason: "<kbd>why</kbd>" }],
        threads: [
          { id: "t1", status: "open", needsPersonIds: ["<mark>jun</mark>"], body: "<b>thread</b>", anchor: null, openedBy: "priya", participants: ["priya"], resolvedBy: null, resolveReason: null },
        ],
        closeOut: { waitingOn: ["<small>waits</small>"], approvedCommit: null, resolution: null },
      },
      subIssues: [
        {
          id: "17",
          title: "<code>fix</code>",
          state: "in_review",
          assignees: [{ kind: "identity", id: handle, session: null, waitingFor: null }],
          reviews: [],
          checks: [],
          approval: {
            head: "owner-jun@c3d4e5f6",
            owners: [
              { owner: "priya", state: "changes_requested", reviewer: "priya", reviewOpId: "x", reason: "<cite>reason</cite>" },
              { owner: "jun", state: "pending", reviewer: null, reviewOpId: null, reason: null },
            ],
            approved: false,
          },
        },
      ],
      timeline: [
        entry("o1", "priya", "create", { title: "t" }),
        entry("o2", "jun.reports", "comment", { body: '<img src=x onerror="globalThis.pwned = 3">' }),
        entry("c1", "penguin", "attach_check", { result: "fail" }),
        entry("r1", "sam", "review", { verdict: "request_changes" }),
        entry("t1", "priya", "open_thread", { body: "<b>thread</b>" }),
        entry("o3", "jun", "reply_thread", { thread: "t1", body: "<strong>reply</strong>" }),
        { ...entry("o4", "sam", "comment", { body: "<sup>late</sup>" }), status: "rejected", rejectReason: "superseded_version", message: "<sub>based on 1</sub>" },
      ],
      runnerInterval: 10_000,
    },
    handle,
  );
  for (const text of [
    "&lt;script&gt;globalThis.pwned = 2&lt;/script&gt;",
    "&lt;img src=x onerror=&quot;globalThis.pwned = 1&quot;&gt;",
    "&lt;img src=x onerror=&quot;globalThis.pwned = 3&quot;&gt;",
    "&lt;em&gt;dau&lt;/em&gt;",
    "&lt;s&gt;log&lt;/s&gt;",
    "&lt;q&gt;no&lt;/q&gt;",
    "&lt;kbd&gt;why&lt;/kbd&gt;",
    "&lt;b&gt;thread&lt;/b&gt;",
    "&lt;strong&gt;reply&lt;/strong&gt;",
    "&lt;mark&gt;jun&lt;/mark&gt;",
    "&lt;sup&gt;late&lt;/sup&gt;",
    "&lt;sub&gt;based on 1&lt;/sub&gt;",
    "&lt;code&gt;fix&lt;/code&gt;",
    "&lt;cite&gt;reason&lt;/cite&gt;",
    "&lt;small&gt;waits&lt;/small&gt;",
    "&lt;u&gt;scope&lt;/u&gt;",
    "&lt;b&gt;codex&lt;/b&gt;",
    "&lt;i&gt;main&lt;/i&gt;",
  ]) {
    assert.ok(html.includes(text), text);
  }
  // The agent's name links to its agent card, with its id encoded into the query.
  assert.match(html, /href="\/identities\?identity=%3Cb%3Eidentity-1%3C%2Fb%3E"/);
  // Only the fix waiting for the viewer carries an ink primary.
  assert.equal(html.match(/class="button primary/g)?.length, 1);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<em>|<s>|<u>|<q>|<kbd>|<mark>|<strong>|<sup>|<sub>|<cite>|<small>|<code>fix|onerror="/);
});

test("markup in a held issue's title, a session's worktree and an operation renders as text on the agent card", async () => {
  const { render } = await load<{ render: (board: unknown, identity: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { IdentityDetail } from "./src/identities-page.tsx";
    export function render(board, identity) {
      const noop = () => {};
      return renderToStaticMarkup(createElement(IdentityDetail, { identity, board, scopes: [], viewer: "jun", navigate: noop, onBack: undefined, onEdit: noop, onDuplicate: noop }));
    }`);
  const { board, identity } = markedTeam();
  const html = render(board, identity);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, /&lt;q&gt;wt&lt;\/q&gt;/);
  assert.match(html, /added &lt;mark&gt;x&lt;\/mark&gt;/);
  assert.match(html, /Reply from &lt;kbd&gt;/);
  assert.match(html, /9b2f10c/);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<q>|<kbd>|<mark>|onerror="/);
});

test("markup in a plan part's changed lines, a requested change and a review exception renders as escaped text", async () => {
  // The plan part list takes its data as props, so it renders on the server without a fetch.
  const { render } = await load<{ render: (inbox: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { PlanPartList } from "./src/plan-parts.tsx";
    export function render(inbox) {
      return renderToStaticMarkup(createElement(PlanPartList, { inbox, busy: undefined, onApprove() {}, onRequestChange() {} }));
    }`);
  const part = {
    ask: "approve",
    feature: "money-minor",
    person: "ines",
    partId: "money-minor/v1#2",
    revision: 2,
    place: { kind: "feature", feature: "tax-rounding" },
    owner: "rahul",
    kind: "behavioural",
    state: "pending",
    changeRequests: 1,
    roundLimit: 3,
    files: [{ path: "tax/rounding.py", status: "modified", lines: [`+total = ${MARKUP}`] }],
    routing: { inPerson: true, reasons: [{ kind: "broken_invariant", scope: "tax", invariant: MARKUP, reviewId: 4 }] },
    changeRequest: { by: "rahul", revision: 1, text: "<script>globalThis.pwned = 2</script>" },
    read: false,
    raisedAt: "2026-10-11T09:00:00.000Z",
  };
  const exception = {
    feature: "money-minor",
    scope: "tax",
    reviewId: 4,
    state: "accepted",
    exceptions: [{ kind: "broken_invariant", invariant: MARKUP, scope: "tax" }],
    read: false,
    raisedAt: "2026-10-11T09:00:00.000Z",
  };
  const html = render({ parts: [part], reviewExceptions: [exception] });
  assert.match(html, /Approve revision 2/);
  assert.match(html, /Request change/);
  assert.match(html, /\+total = &lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;/);
  assert.match(html, /rahul asked on revision 1: &lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, /Review 4 of tax on money-minor, accepted/);
  assert.doesNotMatch(html, /<img|<script|onerror="/);
  // A part of the person's own plan past the round limit is shown without controls.
  const limited = render({ parts: [{ ...part, ask: "round_limit", state: "round_limit" }], reviewExceptions: [] });
  assert.match(limited, /Past the round limit/);
  assert.doesNotMatch(limited, /<button/);
});
