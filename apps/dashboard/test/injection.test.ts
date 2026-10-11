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

test("markup in an issue title renders as escaped text on the inbox page", async () => {
  // The inbox page takes its data as props, so it renders on the server without a fetch.
  const { render } = await load<{ render: (items: unknown[]) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { InboxPage } from "./src/inbox-page.tsx";
    export function render(items) {
      const inbox = { load: { kind: "ready", items }, marking: new Set(), markFailed: false, markRead() {} };
      return renderToStaticMarkup(createElement(InboxPage, { inbox, navigate() {} }));
    }`);
  const html = render([
    { issueId: "40", reason: "assigned", read: false, raisedAt: "2026-10-11T09:00:00.000Z", title: `${MARKUP} @jun/<b>reports</b>`, state: "open" },
    { issueId: "41", reason: "mentioned", read: false, raisedAt: "2026-10-11T09:01:00.000Z", title: "<script>globalThis.pwned = 2</script>", state: "open" },
  ]);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt; @jun\/&lt;b&gt;reports&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|<b>/);
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
