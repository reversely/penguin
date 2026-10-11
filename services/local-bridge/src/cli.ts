import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import { CheckpointPublisher, type ConsentScope } from "./checkpoint.ts";
import { ISSUE_USAGE, runIssueCommand, runKeyCommand } from "./issue-cli.ts";
import { KeychainStore, type KeyStore } from "./key-store.ts";
import { WorktreeRegistry, worktreeId } from "./registry.ts";

export interface CliIo {
  write: (text: string) => void;
  /** Prints `question` and resolves with the owner's answer line. */
  ask: (question: string) => Promise<string>;
}

const USAGE = `Usage: penguin-bridge checkpoint --owner <id> --project <id> --fork <bare repo path>
                      [--worktree <path>] [--consent each-publish|worktree|project]
                      [--remote <url>]
`;

export interface CliDependencies {
  /** Where the bridge signing key lives. Defaults to the OS keychain. */
  keyStore?: KeyStore;
}

const CONSENT_SCOPES: readonly ConsentScope[] = ["each-publish", "worktree", "project"];

/** Runs one bridge command. Resolves with the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo, deps: CliDependencies = {}): Promise<number> {
  const [command, ...rest] = argv;
  const keyStore = deps.keyStore ?? new KeychainStore();
  if (command === "issue") return runIssueCommand(rest, io, keyStore);
  if (command === "key") return runKeyCommand(rest, io, keyStore);
  if (command !== "checkpoint") {
    io.write(USAGE + ISSUE_USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: [...rest],
    options: {
      owner: { type: "string" },
      project: { type: "string" },
      fork: { type: "string" },
      worktree: { type: "string", default: process.cwd() },
      consent: { type: "string", default: "worktree" },
      remote: { type: "string" },
    },
    strict: true,
  });
  const consent = values.consent as ConsentScope;
  if (!values.owner || !values.project || !values.fork || !CONSENT_SCOPES.includes(consent)) {
    io.write(USAGE);
    return 2;
  }

  // The bridge ID only salts path hashes; a one-shot command needs no persistent one.
  const bridgeId = "local";
  const worktree = (await runGit(resolve(values.worktree), ["rev-parse", "--show-toplevel"])).trim();
  const registry = new WorktreeRegistry({ repoPath: worktree, bridgeId, ownerId: values.owner });
  await registry.refresh();

  const publisher = new CheckpointPublisher({
    registry,
    fork: {
      owner_id: values.owner,
      project_id: values.project,
      repo: resolve(values.fork),
      latest_checkpoint_sha: null,
      publishing_consent: consent,
    },
    write: io.write,
    confirm: async () => /^y(es)?$/i.test((await io.ask("Publish this checkpoint? [y/N] ")).trim()),
  });
  const result = await publisher.publish(worktreeId(bridgeId, worktree), values.remote);
  if (result.status === "up-to-date") io.write(`The fork already has checkpoint ${result.checkpoint_sha}.\n`);
  return result.status === "refused" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const io: CliIo = {
    write: (text) => process.stdout.write(text),
    // A closed stdin (no answer) counts as a refusal.
    ask: (question) => readline.question(question).catch(() => ""),
  };
  runCli(process.argv.slice(2), io)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => readline.close());
}
