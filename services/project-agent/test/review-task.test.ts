// A review task run headless (#138, PRD 0.5 section 4.4a): the claim issues a task token for the one
// form, every call is checked against the task before it runs the same code a session's call runs,
// and the bridge's report counts only when the run submitted a form Penguin kept.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { claimEditTasks, reportEditTask, syncEditWork } from "../src/edit-work.ts";
import { reviewTaskCall, taskSessionId, type ReviewTaskCall } from "../src/review-task.ts";
import { CHECKPOINT, FEATURE, PART, ReviewProject } from "./review-project.ts";

const FORM = JSON.parse(readFileSync(join(import.meta.dirname, "../../../examples/helpful-fix/reviews/analytics.json"), "utf8"));

/** Jun's bridge claims the review task and gets its spec and task token. */
async function claimed(project: ReviewProject) {
  const claim = await claimEditTasks(project.editDeps(), "jun", "bridge-jun");
  const spec = claim.tasks.find((each) => each.kind === "review");
  assert.ok(spec !== undefined, JSON.stringify(claim.tasks));
  const token = claim.mcp[spec.taskId];
  assert.ok(token !== undefined);
  return { spec, token };
}

const call = (project: ReviewProject, taskId: number, each: ReviewTaskCall, owner = "jun") => reviewTaskCall(project.callDeps(), owner, taskId, each);
const submit = (feature: string, scope: string) => ({ tool: "submit_review", input: { feature, scope, form: FORM } }) as const;

test("a bridge claims a review like any task, with a task token that expires with the claim", async () => {
  const project = await ReviewProject.load();
  await syncEditWork(project.editDeps());
  const { spec, token } = await claimed(project);
  assert.deepEqual([spec.handle, spec.fork, spec.scopes, spec.review], ["@jun/steward", `feature-${FEATURE}`, ["analytics"], { feature: FEATURE, scope: "analytics", part: PART, revision: 1 }]);
  assert.match(token.token, /^pgt_[A-Za-z0-9_-]{43}$/u);
  assert.equal(token.expiresAt, spec.leaseUntil);
  assert.deepEqual(await project.tokens.authenticate(token.token), { tokenId: (await project.tokens.authenticate(token.token))?.tokenId, ownerId: "jun", task: { taskId: spec.taskId } });
  // The token stops at the end of the claim.
  project.now = Date.parse(spec.leaseUntil);
  assert.equal(await project.tokens.authenticate(token.token), undefined);
});

test("without task tokens the bridge leaves a review to a session", async () => {
  const project = await ReviewProject.load();
  await syncEditWork(project.editDeps(false));
  const claim = await claimEditTasks(project.editDeps(false), "jun", "bridge-jun");
  assert.deepEqual([claim.tasks, claim.mcp], [[], {}]);
});

test("the token allows the form for its one part revision and scope, and nothing else", async () => {
  const project = await ReviewProject.load();
  await syncEditWork(project.editDeps());
  const { spec } = await claimed(project);
  const refused = async (each: ReviewTaskCall, owner?: string) => {
    const answer = await call(project, spec.taskId, each, owner);
    assert.equal(answer.status, "rejected", JSON.stringify(answer));
    return answer.status === "rejected" ? answer.message : "";
  };
  assert.match(await refused({ tool: "get_work", input: {} } as unknown as ReviewTaskCall), /allows submit_review, whats_near and impact, not get_work/u);
  assert.match(await refused(submit(FEATURE, "messaging")), /scope analytics on part utc-day\/v1#1 revision 1 alone/u);
  assert.match(await refused(submit("weekly-report", "analytics")), /feature utc-day alone/u);
  assert.match(await refused({ tool: "impact", input: { feature: "weekly-report" } }), /feature utc-day alone/u);
  assert.match(await refused(submit(FEATURE, "analytics"), "sam"), /no edit task/u);
  assert.equal(project.reviews.list(FEATURE).length, 0);

  // The form for the task's scope goes through the same checks as a session's and is kept pending.
  const answer = await call(project, spec.taskId, submit(FEATURE, "analytics"));
  assert.ok(answer.status === "called" && answer.tool === "submit_review" && answer.outcome.status === "ok", JSON.stringify(answer));
  assert.deepEqual([answer.outcome.state, answer.outcome.forkSha], ["pending", CHECKPOINT]);
  const [stored] = project.reviews.list(FEATURE);
  assert.deepEqual([stored?.reviewer, stored?.sessionId, stored?.ownerId, stored?.scopeId], ["@jun/steward", taskSessionId(spec.taskId), "jun", "analytics"]);

  // The read tools answer as they answer a session.
  const near = await call(project, spec.taskId, { tool: "whats_near", input: { scopes: ["analytics"] } });
  assert.ok(near.status === "called" && near.tool === "whats_near" && near.outcome.status === "ok", JSON.stringify(near));
  const impact = await call(project, spec.taskId, { tool: "impact", input: { feature: FEATURE } });
  assert.ok(impact.status === "called" && impact.tool === "impact" && "outcome" in impact && impact.outcome.status === "ok", JSON.stringify(impact));
  assert.equal(project.runs.list(FEATURE).at(-1)?.sessionId, taskSessionId(spec.taskId));
});

test("a part that moves on, a report and the end of the claim each end the token's reach", async () => {
  const project = await ReviewProject.load();
  await syncEditWork(project.editDeps());
  const { spec, token } = await claimed(project);
  project.part(2, "pending");
  const moved = await call(project, spec.taskId, submit(FEATURE, "analytics"));
  assert.match(moved.status === "rejected" ? moved.message : "", /no longer waits for a review at revision 1/u);
  project.part(1, "pending");
  // The bridge reports the run: the token is revoked, and a run that sent no form is no review.
  const report = await reportEditTask(project.editDeps(), "jun", "bridge-jun", spec.taskId, { status: "done", outcome: "claude -p finished the review" });
  assert.deepEqual(report, { status: "rejected", reason: "invalid", message: "the run submitted no review form" });
  assert.equal(await project.tokens.authenticate(token.token), undefined);
  assert.deepEqual([project.tasks.get(spec.taskId)?.state, project.tasks.get(spec.taskId)?.askReason], ["asked", "run_failed"]);
  const after = await call(project, spec.taskId, submit(FEATURE, "analytics"));
  assert.match(after.status === "rejected" ? after.message : "", /is asked; its token no longer holds/u);
});

test("a run that submitted a kept form reports done, and the task closes as done", async () => {
  const project = await ReviewProject.load();
  await syncEditWork(project.editDeps());
  const { spec } = await claimed(project);
  // A refused form keeps the task open: the run fixes it and submits again.
  const broken = await call(project, spec.taskId, { tool: "submit_review", input: { feature: FEATURE, scope: "analytics", form: { rows: [] } } });
  assert.ok(broken.status === "called" && broken.tool === "submit_review" && broken.outcome.status === "ok" && broken.outcome.state === "refused");
  await syncEditWork(project.editDeps());
  assert.equal(project.tasks.get(spec.taskId)?.state, "running");
  await call(project, spec.taskId, submit(FEATURE, "analytics"));
  // A sync between the form and the report already closes the task; the report confirms it.
  await syncEditWork(project.editDeps());
  assert.equal(project.tasks.get(spec.taskId)?.state, "done");
  const report = await reportEditTask(project.editDeps(), "jun", "bridge-jun", spec.taskId, { status: "done", outcome: "claude -p finished the review" });
  assert.equal(report.status, "ok", JSON.stringify(report));
  // A review's report names no commit.
  const project2 = await ReviewProject.load();
  await syncEditWork(project2.editDeps());
  const second = await claimed(project2);
  await call(project2, second.spec.taskId, submit(FEATURE, "analytics"));
  const withCommit = await reportEditTask(project2.editDeps(), "jun", "bridge-jun", second.spec.taskId, { status: "done", outcome: "x", commit: "e".repeat(40) });
  assert.equal(withCommit.status, "rejected");
  const done = await reportEditTask(project2.editDeps(), "jun", "bridge-jun", second.spec.taskId, { status: "done", outcome: "codex exec finished the review" });
  assert.ok(done.status === "ok" && done.task.state === "done", JSON.stringify(done));
});

test("a review asked for a session before #138 goes back to the queue for the bridge", async () => {
  const project = await ReviewProject.load();
  await syncEditWork(project.editDeps());
  const [task] = project.tasks.forFeature(FEATURE);
  project.sql.exec(`UPDATE EditTask SET state = 'asked', ask_reason = 'needs_session' WHERE id = ?`, task!.id);
  const claim = await claimEditTasks(project.editDeps(), "jun", "bridge-jun");
  assert.deepEqual(claim.tasks.map((each) => each.taskId), [task!.id]);
});
