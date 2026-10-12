// A stand-in for `claude` and `codex` in the edit-run tests. It records its arguments and the Git
// credential variables it sees, then acts as FAKE_AGENT_MODE says: `success` edits the task's file,
// `outside` edits a file outside the task, `fail` exits 1, `error` reports an error result, `idle`
// changes nothing and `hang` waits until it is killed. It prints output in the vendor's format.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const codex = args[0] === "exec";
const mode = process.env["FAKE_AGENT_MODE"] ?? "success";
const record = process.env["FAKE_AGENT_RECORD"];
if (record !== undefined && record !== "") {
  const gitConfig = Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG"));
  writeFileSync(record, JSON.stringify({ args, cwd: process.cwd(), gitConfig }));
}

const finish = (isError: boolean) => {
  if (codex) {
    process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "t" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: isError ? "turn.failed" : "turn.completed" })}\n`);
  } else {
    process.stdout.write(JSON.stringify({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError, result: "a transcript line" }));
  }
};

if (mode === "hang") setTimeout(() => undefined, 600_000);
else if (mode === "fail") process.exit(1);
else {
  if (mode === "success") appendFileSync(join(process.cwd(), "analytics", "weekly.py"), "# adapted to start_of_local_day\n");
  if (mode === "outside") appendFileSync(join(process.cwd(), "README.md"), "edited\n");
  finish(mode === "error");
}
