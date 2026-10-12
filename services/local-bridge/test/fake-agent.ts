// A stand-in for `claude` and `codex` in the edit-run tests. It records its arguments and the Git
// credential variables it sees, then acts as FAKE_AGENT_MODE says: `success` edits the task's file,
// `outside` edits a file outside the task, `fail` exits 1, `error` reports an error result, `idle`
// changes nothing and `hang` waits until it is killed. It prints output in the vendor's format.
//
// `review` acts as a review run's CLI (#138): it finds Penguin's MCP server where the vendor would,
// claude's --mcp-config file or codex's `-c mcp_servers.penguin.*` settings and the variable they
// name, then over plain JSON-RPC lists the tools, calls a tool the token does not allow, submits the
// form for the task's feature and scope from the prompt, and submits one for another scope. Each
// answer goes into the record. `review-none` reaches the server but submits nothing.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const codex = args[0] === "exec";
const mode = process.env["FAKE_AGENT_MODE"] ?? "success";
const record = process.env["FAKE_AGENT_RECORD"];
const seen: Record<string, unknown> = { args, cwd: process.cwd(), gitConfig: Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG")) };
const keep = () => {
  if (record !== undefined && record !== "") writeFileSync(record, JSON.stringify(seen));
};
keep();

/** Where the vendor finds Penguin's MCP server and its token. */
function mcpServer(): { url: string; authorization: string } {
  if (!codex) {
    const file = args[args.indexOf("--mcp-config") + 1] as string;
    const server = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }).mcpServers["penguin"];
    return { url: server?.url as string, authorization: server?.headers["Authorization"] as string };
  }
  const setting = (key: string) => {
    const found = args.find((arg) => arg.startsWith(`mcp_servers.penguin.${key}=`));
    return found === undefined ? undefined : (JSON.parse(found.slice(found.indexOf("=") + 1)) as string);
  };
  return { url: setting("url") as string, authorization: `Bearer ${process.env[setting("bearer_token_env_var") as string] ?? ""}` };
}

async function review(submit: boolean): Promise<void> {
  const { url, authorization } = mcpServer();
  seen["tokenEnv"] = Object.keys(process.env).filter((key) => key === "PENGUIN_TASK_TOKEN");
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data === undefined ? text : data.slice(6)) as {
      result?: { tools?: { name: string }[]; isError?: boolean; structuredContent?: unknown; content?: { text: string }[] };
      error?: { message: string };
    };
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "0" } });
  seen["tools"] = (await rpc("tools/list", {})).result?.tools?.map((tool) => tool.name).sort();
  const call = async (name: string, input: Record<string, unknown>) => {
    const answer = await rpc("tools/call", { name, arguments: input });
    const value = answer.result?.structuredContent ?? answer.result?.content?.[0]?.text ?? answer.error?.message ?? null;
    return { isError: answer.error !== undefined || answer.result?.isError === true, value };
  };
  seen["otherTool"] = await call("get_work", { sessionId: "s" });
  if (submit) {
    const prompt = codex ? (args.at(-1) as string) : (args[args.indexOf("-p") + 1] as string);
    const [, feature, scope] = /feature "([^"]+)" and scope "([^"]+)"/u.exec(prompt) ?? [];
    const formFile = process.env["FAKE_REVIEW_FORM"];
    const form = formFile === undefined || formFile === "" ? { rows: [{ invariant: "evening-activity-local-day", verdict: "holds", evidence: ["analytics/weekly.py:1"], storedData: "none" }] } : JSON.parse(readFileSync(formFile, "utf8"));
    seen["submitted"] = await call("submit_review", { feature, scope, form });
    seen["otherScope"] = await call("submit_review", { feature, scope: "messaging", form });
  }
  keep();
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
else if (mode === "review" || mode === "review-none") {
  await review(mode === "review");
  finish(false);
} else {
  if (mode === "success") appendFileSync(join(process.cwd(), "analytics", "weekly.py"), "# adapted to start_of_local_day\n");
  if (mode === "outside") appendFileSync(join(process.cwd(), "README.md"), "edited\n");
  finish(mode === "error");
}
