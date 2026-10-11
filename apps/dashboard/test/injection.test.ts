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

test("markup in an issue title renders as escaped text on the inbox page", async () => {
  // The inbox page takes its data as props, so it renders on the server without a fetch.
  const entry = `
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { InboxPage } from "./src/inbox-page.tsx";
    export function render(items) {
      const inbox = { load: { kind: "ready", items }, marking: new Set(), markFailed: false, markRead() {} };
      return renderToStaticMarkup(createElement(InboxPage, { inbox, navigate() {} }));
    }`;
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
    const file = join(dir, "inbox.cjs");
    await writeFile(file, bundle.outputFiles[0]!.text);
    const { render } = createRequire(import.meta.url)(file) as { render: (items: unknown[]) => string };
    const html = render([
      { issueId: "40", reason: "assigned", read: false, raisedAt: "2026-10-11T09:00:00.000Z", title: `${MARKUP} @jun/<b>reports</b>`, state: "open" },
      { issueId: "41", reason: "mentioned", read: false, raisedAt: "2026-10-11T09:01:00.000Z", title: "<script>globalThis.pwned = 2</script>", state: "open" },
    ]);
    assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt; @jun\/&lt;b&gt;reports&lt;\/b&gt;/);
    assert.match(html, /&lt;script&gt;globalThis\.pwned = 2&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img|<script|<b>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
