// The caller card says what Penguin replayed (#214): the receiving feature's tests run on main and
// with the originating feature, the first differing call open with both sides and the differing field
// marked on each, the rest behind a line counting them. Case 1's weekly-digest item renders on the
// server, bundled with esbuild, since Node runs TypeScript but not JSX.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CallerItemView, CallerSideView } from "@penguin/protocol";
import { build } from "esbuild";

const returned = (value: unknown): CallerSideView => ({ status: "returned", value: JSON.stringify(value), error: null, effects: [], effectCount: 0 });

const call = (index: number, test: string): CallerItemView["differing"][number] => ({
  callId: `call-${String(index).repeat(20)}`,
  test,
  symbol: "messaging.subscriptions.is_subscribed",
  differs: ["result"],
  old: returned(true),
  new: returned(false),
  kind: null,
  verdict: null,
});

/** Case 1's item in Sam's weekly digest: Priya's accounts-merge changes who counts as subscribed. */
const ITEM: CallerItemView = {
  itemId: "caller-0123456789abcdef0123",
  origin: "accounts-merge",
  originPerson: "priya",
  feature: "weekly-digest",
  person: "sam",
  contract: "messaging/subscriptions.py::is_subscribed",
  verdict: "differs",
  state: "differs",
  waitingOn: "originating_agent",
  ownerAsked: null,
  rejections: 0,
  callers: [{ path: "messaging/audience.py", line: 24, verdict: "differs", calls: 10, matched: 7, differingCount: 3 }],
  differing: [
    {
      ...call(1, "messaging/tests/test_consent.py::test_unsubscribe_survives"),
      old: returned({ email: "a@example.com", identities: ["d1"], email_subscribed: true, note: "x".repeat(300) }),
      new: returned({ email: "a@example.com", identities: ["d1", "u1"], email_subscribed: false, note: "x".repeat(300) }),
    },
    call(2, "messaging/tests/test_audience.py::test_an_address_unsubscribed_on_any_shopper_is_suppressed"),
    call(3, "messaging/tests/test_audience.py::test_inactive_subscribed_shoppers_are_in_the_audience"),
  ],
  refusals: [],
  explanation: null,
  fix: null,
  review: null,
  openedAt: "2026-03-03T14:00:00Z",
  updatedAt: "2026-03-03T14:00:00Z",
  recordId: "record-1",
};

const ENTRY = `
import { renderToStaticMarkup } from "react-dom/server";
import { CallerCard } from "./src/caller-card.tsx";
export const html = (item) => renderToStaticMarkup(<CallerCard item={item} title="feature" navigate={() => undefined} />);
`;

async function renderCard(item: CallerItemView): Promise<string> {
  const bundled = await build({
    stdin: { contents: ENTRY, loader: "tsx", resolveDir: join(import.meta.dirname, "..") },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const file = join(await mkdtemp(join(tmpdir(), "penguin-card-")), "card.mjs");
  await writeFile(file, bundled.outputFiles[0]!.text);
  const { html } = (await import(file)) as { html: (item: CallerItemView) => string };
  return html(item);
}

const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replace(/\s+/gu, " ");

test("case 1's weekly-digest card says what Penguin replayed and opens the first differing call on both sides", async () => {
  const html = await renderCard(ITEM);
  const shown = text(html);
  assert.match(shown, /Penguin ran weekly-digest's tests on main and with accounts-merge 3 calls changed/u);
  assert.match(shown, /messaging\/audience\.py:24 differs 7 of 10 calls same as on main/u);

  const [open, closed] = html.split("<details");
  assert.ok(closed !== undefined, "the remaining calls sit behind a disclosure");
  const first = text(open!);
  assert.match(first, /test_unsubscribe_survives/u);
  assert.match(first, /On main Result \{"email":"a@example\.com","identities":\["d1"\],"email_subscribed":true/u);
  assert.match(first, /With accounts-merge Result \{"email":"a@example\.com","identities":\["d1","u1"\],"email_subscribed":false/u);
  assert.equal(first.match(/ differs /gu)?.length, 3, "the call site's verdict, then the result marked on each side");
  assert.match(text(closed), /2 more changed calls/u);
  assert.doesNotMatch(text(closed), /test_inactive_subscribed/u, "the rest render only once opened");
});

test("a value renders as text, never as markup", async () => {
  const [first] = ITEM.differing;
  const html = await renderCard({ ...ITEM, differing: [{ ...first!, new: returned("<img src=x onerror=alert(1)>") }] });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});
