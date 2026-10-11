import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { build } from "esbuild";

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

/** Bundles `entry` for Node and returns its exports, so a page renders on the server without a browser. */
async function load<T>(entry: string): Promise<T> {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const dir = await mkdtemp(join(tmpdir(), "penguin-render-"));
  try {
    const file = join(dir, "entry.cjs");
    await writeFile(file, bundle.outputFiles[0]!.text);
    return createRequire(import.meta.url)(file) as T;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
        createElement(IdentityDetail, { identity, scopes, viewer: identity.owners[0], navigate: noop, onBack: noop, onEdit: noop, onDuplicate: noop }),
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
      sessions: [{ id: "s1", vendor: "<b>codex</b>", branch: "b", status: "running", lastSeen: "2026-10-11T09:00:00.000Z" }],
      history: [],
    },
    [{ id: "analytics", name: "<s>Analytics</s>", ownerId: "jun", testCommand: "<kbd>pytest</kbd>" }],
  );
  assert.match(html, /@jun\/&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;/);
  assert.match(html, /&lt;b&gt;Reports&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, /jun, &lt;i&gt;sam&lt;\/i&gt;/);
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

test("markup in an owner, a handle, a session, an issue title, a reviewer and a thread renders as text on the board", async () => {
  const { render } = await load<{ render: (board: unknown) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { BoardView } from "./src/board-page.tsx";
    export function render(board) {
      return renderToStaticMarkup(createElement(BoardView, { board, viewer: "jun", showAll: false, navigate() {} }));
    }`);
  const handle = `@jun/${MARKUP}`;
  const session = { id: "s1", vendor: "<b>codex</b>", branch: "<i>main</i>", status: "running" };
  const html = render({
    owners: [
      {
        id: "jun",
        identities: [{ handle, name: `<u>${MARKUP}</u>`, avatar: null, team: false, sessions: [{ ...session, lastSeen: "2026-10-11T09:00:00.000Z" }] }],
      },
      { id: `<em>${MARKUP}</em>`, identities: [{ handle: "@x/<s>idle</s>", name: "idle", avatar: null, team: true, sessions: [] }] },
    ],
    issues: [
      {
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
          reviews: [{ opId: "r1", reviewer: `<q>${MARKUP}</q>`, verdict: "approve", reason: null, repo: "r", sha: "1", counts: false, uncountedReason: MARKUP }],
          threads: [{ id: "t1", status: "open", needsPersonIds: [`<kbd>${MARKUP}</kbd>`] }],
        },
        subIssues: [],
        laneOwners: { [handle]: ["jun"] },
      },
    ],
  });
  assert.match(html, /@jun\/&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;codex&lt;\/b&gt;/);
  assert.match(html, /title="&lt;i&gt;main&lt;\/i&gt;"/);
  assert.match(html, /&lt;em&gt;/);
  assert.match(html, /@x\/&lt;s&gt;idle&lt;\/s&gt;/);
  assert.match(html, /Reply from &lt;kbd&gt;/);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<em>|<s>|<u>|<q>|<kbd>|onerror="/);
});
