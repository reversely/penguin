// The `penguin-bridge fix-write` command: the originating agent's side of writing an approved plan
// part's fix (PRD 0.4 section 4.4 step 1). The agent pipes the answer of the `fix_token` MCP tool to it;
// the command writes the fix as one commit on the affected feature's fork with the token in that
// answer. It prints the commit for `report_fix_write`. The token stays in memory.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import type { CliIo } from "./cli.ts";
import { writeFix } from "./fix-write.ts";
import { penguinRemote, tokenRemote } from "./git-remote.ts";
import { fixWriteSpecOf } from "./penguin-client.ts";

export const FIX_WRITE_USAGE = `       penguin-bridge fix-write [--repo <path>] [--state-dir <dir>]
         Reads the answer of the fix_token MCP tool on stdin and writes the approved part's fix into
         the affected feature's fork: the patch applied to the fork head as one commit with Penguin's
         message, pushed as a fast-forward of the fork's main. The fork is fetched into <path>
         (default <state-dir>/fix-writes). Prints the commit as JSON; pass it to report_fix_write.
`;

/** Runs `fix-write`. Resolves with 0 when the fix was pushed, 1 when it was not, 2 for bad input. */
export async function runFixWriteCommand(
  args: readonly string[],
  io: CliIo,
  stateDir: string,
  readInput: () => Promise<string> = () => text(process.stdin),
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: [...args], options: { repo: { type: "string" }, "state-dir": { type: "string" } }, strict: true }));
  } catch (error) {
    io.write(`${(error as Error).message}\n${FIX_WRITE_USAGE}`);
    return 2;
  }
  let answer: unknown;
  try {
    answer = JSON.parse(await readInput());
  } catch {
    io.write("stdin must hold the fix_token answer as JSON\n");
    return 2;
  }
  // The answer as the tool's structured content, or the whole MCP result around it.
  const content = ((answer as { structuredContent?: unknown } | null)?.structuredContent ?? answer) as Record<string, unknown> | null;
  const spec = fixWriteSpecOf(content?.["write"]);
  const token = (content?.["token"] ?? {}) as Record<string, unknown>;
  if (spec === undefined || spec.writer !== "agent" || token["fork"] !== spec.fork || typeof token["token"] !== "string" || typeof token["remote"] !== "string") {
    io.write("the answer holds no fix write with a token on its fork; pass fix_token's answer unchanged\n");
    return 2;
  }
  const repo = resolve(values.repo ?? join(values["state-dir"] ?? stateDir, "fix-writes"));
  if (!existsSync(repo)) {
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await runGit(repo, ["init", "--quiet", "--bare"]);
  }
  const remote = tokenRemote(penguinRemote(spec.fork), { token: token["token"], remote: token["remote"] });
  const result = await writeFix({ repoPath: repo, remote }, spec);
  const base = { feature: spec.feature, part: spec.partId, revision: spec.revision, fork: spec.fork };
  io.write(`${JSON.stringify({ ...base, ...result })}\n`);
  return result.status === "written" ? 0 : 1;
}
