#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CheckpointPublisher, type ConsentScope } from "./checkpoint.ts";
import { CHECK_USAGE, runCheckCommand } from "./check-cli.ts";
import { bridgeReporter } from "./checkpoint-report.ts";
import { CONSENT_USAGE, runConsentCommand } from "./consent-cli.ts";
import { bridgeConsent } from "./consent-store.ts";
import { isPenguinRemote, penguinRemote } from "./git-remote.ts";
import { FIX_WRITE_USAGE, runFixWriteCommand } from "./fix-write-cli.ts";
import { PREVIEW_USAGE, runPreviewCommand } from "./preview-cli.ts";
import { IMPACT_USAGE, runImpactCommand } from "./impact-cli.ts";
import { ISSUE_USAGE, runIssueCommand, runKeyCommand } from "./issue-cli.ts";
import { KeychainStore, type KeyStore } from "./key-store.ts";
import { bridgeRemotes, registerBridge, type Fetch } from "./penguin-client.ts";
import { WorktreeRegistry } from "./registry.ts";
import { RESOLVE_USAGE, runApplyFixCommand, runResolveCommand } from "./resolve-cli.ts";
import { REVIEW_USAGE, runReviewCommand } from "./review-cli.ts";
import { RUNNER_USAGE, runRunnerCommand } from "./runner-cli.ts";
import {
  afterPublish,
  LOCAL_BRIDGE_ID,
  runSessionCheckpointCommand,
  runWorktreeIdCommand,
  SESSION_CHECKPOINT_USAGE,
  worktreeAt,
} from "./session-checkpoint.ts";
import { bridgeSpool, defaultStateDir, runSpoolCommand, SPOOL_USAGE } from "./spool-cli.ts";

export interface CliIo {
  write: (text: string) => void;
  /** Prints `question` and resolves with the owner's answer line. */
  ask: (question: string) => Promise<string>;
}

const USAGE = `Usage: penguin-bridge register --server <url> --owner <id> --code <code> [--state-dir <dir>]
       penguin-bridge checkpoint --owner <id> --project <id> [--fork penguin:owner-<id>|<bare repo path>]
                      [--worktree <path>] [--consent each-publish|worktree|project]
                      [--remote <url>] [--identity @<owner>/<name>] [--agent-trailer on|off]
                      [--state-dir <dir>]
`;

export interface CliDependencies {
  /** Where the bridge signing key and bridge token live. Defaults to the OS keychain. */
  keyStore?: KeyStore;
  /**
   * The bridge's state folder: the outbound spool, the issues clones and the registration record.
   * Defaults to ~/.penguin; a command's --state-dir overrides it.
   */
  stateDir?: string;
  /** How the bridge reaches Penguin. Defaults to the global fetch. */
  fetch?: Fetch;
}

const CONSENT_SCOPES: readonly ConsentScope[] = ["each-publish", "worktree", "project"];

/** Runs one bridge command. Resolves with the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo, deps: CliDependencies = {}): Promise<number> {
  const [command, ...rest] = argv;
  const keyStore = deps.keyStore ?? new KeychainStore();
  const stateDir = deps.stateDir ?? defaultStateDir();
  const remotesFor = (dir: string) => bridgeRemotes(dir, keyStore, deps.fetch);
  const reporterFor = (dir: string) => bridgeReporter(dir, keyStore, deps.fetch);
  if (command === "register") return runRegisterCommand(rest, io, keyStore, stateDir, deps.fetch);
  if (command === "issue") return runIssueCommand(rest, io, keyStore, stateDir, remotesFor);
  if (command === "key") return runKeyCommand(rest, io, keyStore);
  if (command === "spool") return runSpoolCommand(rest, io, stateDir, remotesFor, reporterFor);
  if (command === "runner") return runRunnerCommand(rest, io, keyStore, stateDir, deps.fetch);
  if (command === "session-checkpoint") return runSessionCheckpointCommand(rest, io, keyStore, stateDir, deps.fetch);
  if (command === "worktree-id") return runWorktreeIdCommand(rest, io);
  if (command === "consent") return runConsentCommand(rest, io, stateDir);
  if (command === "impact") return runImpactCommand(rest, io);
  if (command === "review") return runReviewCommand(rest, io);
  if (command === "check") return runCheckCommand(rest, io);
  if (command === "resolve") return runResolveCommand(rest, io);
  if (command === "apply-fix") return runApplyFixCommand(rest, io);
  if (command === "fix-write") return runFixWriteCommand(rest, io, stateDir);
  if (command === "preview") return runPreviewCommand(rest, io, stateDir, (dir) => bridgeRemotes(dir, keyStore, deps.fetch, "read"));
  if (command !== "checkpoint") {
    io.write(
      USAGE +
        CONSENT_USAGE +
        ISSUE_USAGE +
        SPOOL_USAGE +
        RUNNER_USAGE +
        SESSION_CHECKPOINT_USAGE +
        IMPACT_USAGE +
        REVIEW_USAGE +
        CHECK_USAGE +
        RESOLVE_USAGE +
        FIX_WRITE_USAGE +
        PREVIEW_USAGE,
    );
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
      identity: { type: "string" },
      "agent-trailer": { type: "string", default: "on" },
      "state-dir": { type: "string" },
    },
    strict: true,
  });
  const consent = values.consent as ConsentScope;
  const agentTrailer = values["agent-trailer"];
  if (!values.owner || !values.project || !CONSENT_SCOPES.includes(consent) || !["on", "off"].includes(agentTrailer)) {
    io.write(USAGE);
    return 2;
  }
  // Without --fork the checkpoint goes to the owner's fork in Artifacts.
  const fork = values.fork ?? penguinRemote(`owner-${values.owner}`);
  const checkpointStateDir = values["state-dir"] ?? stateDir;

  // The bridge ID only salts path hashes; a one-shot command needs no persistent one.
  const bridgeId = LOCAL_BRIDGE_ID;
  const { root: worktree, id } = await worktreeAt(values.worktree);
  const registry = new WorktreeRegistry({ repoPath: worktree, bridgeId, ownerId: values.owner });
  await registry.refresh();

  const publisher = new CheckpointPublisher({
    registry,
    fork: {
      owner_id: values.owner,
      project_id: values.project,
      repo: isPenguinRemote(fork) ? fork : resolve(fork),
      latest_checkpoint_sha: null,
      publishing_consent: consent,
      agent_trailer: agentTrailer === "on",
    },
    write: io.write,
    spool: bridgeSpool(checkpointStateDir),
    remotes: remotesFor(checkpointStateDir),
    reporter: reporterFor(checkpointStateDir),
    // A yes is kept in the state folder: this command publishes once and exits.
    consent: bridgeConsent(checkpointStateDir),
    confirm: async () => /^y(es)?$/i.test((await io.ask("Publish this checkpoint? [y/N] ")).trim()),
  });
  const started = performance.now();
  const result = await publisher.publish(id, {
    remote: values.remote,
    identity: values.identity,
  });
  if (result.status === "up-to-date") io.write(`The fork already has checkpoint ${result.checkpoint_sha}.\n`);
  if (result.status === "published") io.write(`Publish took ${Math.round(performance.now() - started)} ms.\n`);
  // A published checkpoint is an explicit safe checkpoint for the sessions in this worktree.
  if (result.status === "published" && isPenguinRemote(fork)) {
    io.write(await afterPublish(checkpointStateDir, keyStore, id, deps.fetch));
  }
  // A queued checkpoint has the owner's consent and waits only for the fork to be reachable.
  return result.status === "refused" ? 1 : 0;
}

/** Runs `register`: spends a registration code and stores the bridge token in the key store. */
async function runRegisterCommand(
  args: readonly string[],
  io: CliIo,
  keyStore: KeyStore,
  defaultStateDir: string,
  fetchImpl: Fetch | undefined,
): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      server: { type: "string" },
      owner: { type: "string" },
      code: { type: "string" },
      "state-dir": { type: "string" },
    },
    strict: true,
  });
  if (!values.server || !values.owner || !values.code) {
    io.write(USAGE);
    return 2;
  }
  const registration = await registerBridge({
    server: values.server,
    owner: values.owner,
    code: values.code,
    keyStore,
    stateDir: values["state-dir"] ?? defaultStateDir,
    fetch: fetchImpl,
  });
  // The bridge token went to the key store and is never printed.
  io.write(
    `Registered bridge ${registration.bridgeId} for ${registration.owner} (${registration.role}) with ${registration.server}.\n` +
      "The bridge token is in the key store; Artifacts tokens are fetched at push time and kept in memory.\n",
  );
  return 0;
}

/**
 * Whether Node started this file as the program. An installed `penguin-bridge` is a symlink to
 * this file and `process.argv[1]` keeps the symlink's path, so the check compares real paths.
 */
function isMainModule(): boolean {
  const started = process.argv[1];
  if (started === undefined) return false;
  try {
    return realpathSync(started) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
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
