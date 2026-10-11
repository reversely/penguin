import assert from "node:assert/strict";
import { test } from "node:test";

import type { IssuePage, IssuePageTimelineEntry } from "@penguin/protocol";

import { load } from "./render.ts";

const INTERVAL = 10_000;

function entry(opId: string, author: string, type: string, payload: unknown, waitedMs: number | null = null): IssuePageTimelineEntry {
  return {
    seq: 1,
    opId,
    author,
    type,
    payload,
    status: "applied",
    rejectReason: null,
    message: null,
    gitCommit: null,
    waitingForGitLog: waitedMs !== null,
    waitedMs,
  };
}

/** A Huddle issue in review: an open thread that needs Jun and fix #17, which waits for Jun's review. */
function huddlePage(timeline: IssuePageTimelineEntry[]): IssuePage {
  return {
    issue: {
      id: "16",
      alias: null,
      title: "Combined run fails on the merged identity map",
      body: "",
      state: "in_review",
      stateReason: null,
      labels: [],
      parentId: null,
      version: 9,
      assignees: [],
      commits: [],
      checks: [],
      reviews: [],
      threads: [
        { id: "t1", status: "open", needsPersonIds: ["jun"], body: "Which window?", anchor: null, openedBy: "priya", participants: ["priya"], resolvedBy: null, resolveReason: null },
        { id: "t2", status: "open", needsPersonIds: ["sam"], body: "Which sync?", anchor: null, openedBy: "priya", participants: ["priya"], resolvedBy: null, resolveReason: null },
      ],
      closeOut: null,
    },
    subIssues: [
      {
        id: "17",
        title: "Keep daily actives stable across merges",
        state: "in_review",
        assignees: [],
        reviews: [
          { opId: "r1", reviewer: "priya", verdict: "request_changes", reason: "Not yet", repo: "owner-jun", sha: "c3d4e5f6", counts: true, uncountedReason: null },
          { opId: "r2", reviewer: "priya", verdict: "approve", reason: null, repo: "owner-jun", sha: "c3d4e5f6", counts: true, uncountedReason: null },
          { opId: "r3", reviewer: "sam", verdict: "approve", reason: null, repo: "owner-jun", sha: "c3d4e5f6", counts: false, uncountedReason: "no review rights" },
        ],
        checks: [],
        approval: {
          head: "owner-jun@c3d4e5f6",
          owners: [
            { owner: "jun", state: "pending", reviewer: null, reviewOpId: null, reason: null },
            { owner: "priya", state: "approved", reviewer: "priya", reviewOpId: "r2", reason: null },
          ],
          approved: false,
        },
      },
    ],
    timeline: [
      ...timeline,
      entry("t1", "priya", "open_thread", { body: "Which window?" }),
      entry("t2", "priya", "open_thread", { body: "Which sync?" }),
    ],
    runnerInterval: INTERVAL,
  };
}

async function renderer() {
  const { render } = await load<{ render: (page: IssuePage) => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { IssueContent } from "./src/issue-page.tsx";
    export function render(page) {
      const identities = { kind: "ready", handles: [], known: new Map() };
      const noop = () => {};
      return renderToStaticMarkup(createElement(IssueContent, { page, viewer: "jun", identities, phone: false, navigate: noop, onSignedOut: noop, onWritten: noop }));
    }`);
  return render;
}

/** The markup of the page's section labelled by `id`, up to the next section. */
function section(html: string, id: string): string {
  const start = html.indexOf(`aria-labelledby="${id}"`);
  assert.notEqual(start, -1, id);
  const end = html.indexOf("<section", start);
  return html.slice(start, end === -1 ? undefined : end);
}

test("the details panel shows one approval row per owner per fix, the latest review counting", async () => {
  const html = (await renderer())(huddlePage([]));
  const subIssues = section(html, "issue-sub-issues");
  assert.equal(subIssues.match(/>priya</g)?.length, 1, "priya approved twice and shows once");
  assert.match(subIssues, /Approved<\/span><span class="row-title">priya</);
  assert.doesNotMatch(subIssues, /Changes requested/, "priya's latest review counts");
  assert.equal(subIssues.match(/>jun</g)?.length, 1);
  assert.equal(subIssues.match(/>sam</g)?.length, 1);
  assert.match(subIssues, /Not counted/);
  // The fix's approval card lists each person once too.
  const card = html.slice(html.indexOf('id="fix-17"'));
  assert.equal(card.match(/class="byline-name">priya</g)?.length, 1);
});

test("the pending-push summary appears once for the issue only after an operation waits past the runner's interval", async () => {
  const render = await renderer();
  const fresh = render(huddlePage([entry("o1", "priya", "comment", { body: "hi" }, INTERVAL - 1), entry("o2", "priya", "comment", { body: "again" }, 0)]));
  assert.doesNotMatch(fresh, /waiting for the Git log/);
  const late = render(huddlePage([entry("o1", "priya", "comment", { body: "hi" }, INTERVAL + 1), entry("o2", "priya", "comment", { body: "again" }, INTERVAL + 5)]));
  assert.equal(late.match(/waiting for the Git log/g)?.length, 1);
  assert.match(late, /<span class="tag waiting">2 updates waiting for the Git log<\/span>/);
  assert.doesNotMatch(late, /Waiting for Git log/, "no entry carries its own tag");
});

test("Needs you lists the viewer's open thread and fix review above the activity, each linking to its card", async () => {
  const html = (await renderer())(huddlePage([]));
  const needs = section(html, "issue-needs-you");
  assert.ok(html.indexOf('aria-labelledby="issue-needs-you"') < html.indexOf('<ol class="thread"'), "the block sits above the activity");
  const links = [...needs.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(links, ["thread-t1", "fix-17"], "only the thread that needs the viewer and the fix waiting for them");
  for (const target of links) assert.match(html, new RegExp(`id="${target}"`), target);
  assert.match(needs, /Thread from priya/);
  assert.match(needs, /Waiting for your reply/);
  assert.match(needs, /#17<\/span> Keep daily actives stable across merges/);
  assert.match(needs, /Waiting for your review/);
});
