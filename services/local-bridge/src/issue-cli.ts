// The `penguin-bridge issue ...` and `penguin-bridge key` commands. Every text field travels as a
// parsed argument into the operation's JSON; nothing here starts a shell.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { Author, IssueId, Party } from "@penguin/protocol";

import type { CliIo } from "./cli.ts";
import { isPenguinRemote, penguinRemote, unregisteredRemotes, type RemoteResolver } from "./git-remote.ts";
import { IssueWriter, type IssueChange } from "./issue-writer.ts";
import { loadSigningKey, type KeyStore } from "./key-store.ts";
import { bridgeSpool } from "./spool-cli.ts";

export const ISSUE_USAGE = `Usage: penguin-bridge issue <command> --owner <id> [--repo penguin:issues|<bare repo path>] [--clone <dir>]
                      [--branch <name>] [--as <person|@owner/name>] [--base-version <n>]
                      [--state-dir <dir>]
  create  --title <text> [--body <text>]
  comment --issue <id> --body <text>
  label   --issue <id> --label <label>
  assign  --issue <id> --to <person|@owner/name>
  review  --issue <id> --verdict approve|request_changes --commit <repo@sha> [--reason <text>]
  state   --issue <id> --state <state> --reason <text>
       penguin-bridge key --owner <id>
`;

const OPTIONS = {
  owner: { type: "string" },
  repo: { type: "string" },
  clone: { type: "string" },
  branch: { type: "string", default: "main" },
  as: { type: "string" },
  "base-version": { type: "string" },
  issue: { type: "string" },
  title: { type: "string" },
  body: { type: "string" },
  label: { type: "string" },
  to: { type: "string" },
  verdict: { type: "string" },
  commit: { type: "string" },
  reason: { type: "string" },
  state: { type: "string" },
  "state-dir": { type: "string" },
} as const;

const parseIssueArgs = (args: string[]) => parseArgs({ args, options: OPTIONS, strict: true });
type Values = ReturnType<typeof parseIssueArgs>["values"];

class UsageError extends Error {}

/** Runs `issue <command> ...`. Resolves with the exit code. */
export async function runIssueCommand(
  args: readonly string[],
  io: CliIo,
  keyStore: KeyStore,
  defaultStateDir: string,
  remotesFor: (stateDir: string) => RemoteResolver = () => unregisteredRemotes,
): Promise<number> {
  const [command, ...rest] = args;
  let values: Values;
  let change: IssueChange;
  let author: Author | undefined;
  let baseVersion: number | undefined;
  try {
    values = parseIssueArgs(rest).values;
    if (!values.owner) throw new UsageError("--owner is required");
    change = buildChange(command, values);
    author = values.as === undefined ? undefined : parseParty(values.as);
    baseVersion = values["base-version"] === undefined ? undefined : parseCount(values["base-version"]);
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof TypeError)) throw error;
    io.write(`${error.message}\n${ISSUE_USAGE}`);
    return 2;
  }

  const started = performance.now();
  const stateDir = values["state-dir"] ?? defaultStateDir;
  // Without --repo the operation goes to the issues repo in Artifacts.
  const repo = values.repo ?? penguinRemote("issues");
  const remote = isPenguinRemote(repo) ? repo : resolve(repo);
  const writer = new IssueWriter({
    remote,
    remotes: remotesFor(stateDir),
    clonePath: resolve(values.clone ?? defaultClonePath(stateDir, remote)),
    branch: values.branch,
    ownerId: values.owner,
    key: await loadSigningKey(keyStore, values.owner),
    spool: bridgeSpool(stateDir),
  });
  const result = await writer.write(change, { author, baseVersion });
  const elapsed = Math.round(performance.now() - started);
  switch (result.status) {
    case "pushed":
      io.write(`Pushed ${result.path} in commit ${(result.commit ?? "").slice(0, 12)} (${elapsed} ms).\n`);
      return 0;
    case "queued":
      // Queued is a success: the operation is signed and on disk, and a drain pushes it later.
      io.write(
        `Queued ${result.path} (${elapsed} ms): ${result.reason}\n` +
          "It is pushed by the next issue command or `penguin-bridge spool drain|watch` once the remote is reachable.\n",
      );
      return 0;
    case "failed":
      io.write(`Not pushed ${result.path}: ${result.reason}\n`);
      return 1;
  }
}

/** Runs `key --owner <id>`: prints the bridge's public signing key, creating the key pair if needed. */
export async function runKeyCommand(args: readonly string[], io: CliIo, keyStore: KeyStore): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { owner: { type: "string" } }, strict: true });
  if (!values.owner) {
    io.write(ISSUE_USAGE);
    return 2;
  }
  const key = await loadSigningKey(keyStore, values.owner);
  io.write(`${JSON.stringify(key.publicJwk)}\n`);
  return 0;
}

function buildChange(command: string | undefined, values: Values): IssueChange {
  const issue = (): IssueId => parseIssue(required(values.issue, "--issue"));
  switch (command) {
    case "create":
      return { type: "create", payload: { title: required(values.title, "--title"), body: values.body } };
    case "comment":
      return { type: "comment", issue: issue(), payload: { body: required(values.body, "--body") } };
    case "label":
      return { type: "add_label", issue: issue(), payload: { label: required(values.label, "--label") } };
    case "assign":
      return { type: "assign", issue: issue(), payload: { assignee: parseParty(required(values.to, "--to")) } };
    case "review": {
      const verdict = required(values.verdict, "--verdict");
      if (verdict !== "approve" && verdict !== "request_changes") {
        throw new UsageError("--verdict must be approve or request_changes");
      }
      const commit = required(values.commit, "--commit");
      return { type: "review", issue: issue(), payload: { verdict, commit, reason: values.reason } };
    }
    case "state":
      return {
        type: "change_state",
        issue: issue(),
        payload: { state: required(values.state, "--state"), reason: required(values.reason, "--reason") },
      };
    default:
      throw new UsageError(`unknown issue command ${JSON.stringify(command ?? "")}`);
  }
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new UsageError(`${flag} is required`);
  return value;
}

/** A display number, or the op_id of the issue's create operation. The schema checks the rest. */
function parseIssue(text: string): IssueId {
  return /^[0-9]+$/u.test(text) ? Number(text) : text;
}

function parseParty(text: string): Party {
  return text.startsWith("@") ? { identity: text } : { person: text };
}

function parseCount(text: string): number {
  if (!/^[0-9]+$/u.test(text)) throw new UsageError("--base-version must be a whole number");
  return Number(text);
}

/** The bridge's clone of an issues repo, under <state dir>/issues/, one folder per remote. */
export function defaultClonePath(stateDir: string, remote: string): string {
  return join(stateDir, "issues", createHash("sha256").update(remote).digest("hex").slice(0, 16));
}
