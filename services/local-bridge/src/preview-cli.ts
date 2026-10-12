// The `penguin-bridge preview` command (PRD 0.4 section 4.5 step 3): an owner who wants to see a block
// before it lands fetches the originating feature's fork with an expiring read token and checks out
// its main or a commit Penguin named. Nothing new is created in Artifacts: the token is a read token on
// the existing fork, minted by Penguin for PENGUIN_TOKEN_TTL_SECONDS and kept in memory only.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isObjectId, runGit } from "@penguin/git-analysis";
import { SEGMENT_PATTERN } from "@penguin/protocol";

import type { CliIo } from "./cli.ts";
import { penguinRemote, type RemoteResolver } from "./git-remote.ts";

export const PREVIEW_USAGE = `       penguin-bridge preview --feature <id> [--commit <sha>] [--dir <path>] [--state-dir <dir>]
         Fetches feature-<id>'s fork with an expiring read token into <path> (default
         <state-dir>/previews/<id>) and checks out <sha>, such as the checkpoint a land names,
         or the fork's main. Nothing is created in Artifacts and nothing is pushed.
`;

const FEATURE_ID = new RegExp(`^${SEGMENT_PATTERN}$`, "u");

/** Runs `preview`. Resolves with 0 when the commit is checked out, 1 when it could not be, 2 for bad input. */
export async function runPreviewCommand(args: readonly string[], io: CliIo, stateDir: string, readRemotes: (dir: string) => RemoteResolver): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { feature: { type: "string" }, commit: { type: "string" }, dir: { type: "string" }, "state-dir": { type: "string" } },
      strict: true,
    }));
  } catch (error) {
    io.write(`${(error as Error).message}\n${PREVIEW_USAGE}`);
    return 2;
  }
  const feature = values.feature;
  if (feature === undefined || !FEATURE_ID.test(feature) || feature.length > 63) {
    io.write(`--feature must be a feature id\n${PREVIEW_USAGE}`);
    return 2;
  }
  if (values.commit !== undefined && !isObjectId(values.commit)) {
    io.write(`--commit must be a full object ID\n${PREVIEW_USAGE}`);
    return 2;
  }
  const state = values["state-dir"] ?? stateDir;
  const dir = resolve(values.dir ?? join(state, "previews", feature));
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await runGit(dir, ["init", "--quiet"]);
  }
  const fork = `feature-${feature}`;
  try {
    // A read token: Penguin holds every bridge to read on another person's fork.
    await readRemotes(state)(penguinRemote(fork)).git(dir, (url) => ["fetch", "--quiet", "--no-tags", "--end-of-options", url, "+refs/heads/*:refs/remotes/feature/*"]);
    const target = values.commit ?? "refs/remotes/feature/main";
    await runGit(dir, ["checkout", "--quiet", "--detach", "--end-of-options", target]);
    const head = (await runGit(dir, ["rev-parse", "HEAD"])).trim();
    io.write(`${JSON.stringify({ feature, fork, dir, commit: head })}\n`);
    return 0;
  } catch (error) {
    io.write(`The preview of ${fork} did not check out: ${(error as Error).message.trim().split("\n").at(-1) ?? ""}\n`);
    return 1;
  }
}
