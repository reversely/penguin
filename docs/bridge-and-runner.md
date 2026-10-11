# Bridge and runner

`penguin-bridge` is the one piece of Penguin each owner runs on their own machine. It publishes the
owner's checkpoints to Penguin after showing the exact changes, writes signed issue operations from
the command line and tells Penguin when an agent session reaches a safe checkpoint. The same program
in runner mode is the project's integration runner: it pushes the operations Penguin applied and runs
the combined tests. The code is in `services/local-bridge/src/`.
[architecture.md](architecture.md) shows where both sit.

## Installing

The bridge needs Node.js 22.18 or later, Git 2.38 or later (for `git merge-tree --write-tree`) and,
on a runner, the test tools the project's `penguin/scopes.json` commands call. The fixtures use
Python with pytest from `uv sync`.

```sh
git clone <penguin repo> ~/penguin
cd ~/penguin && npm install
```

The hook settings and every example call the bridge as `penguin-bridge`. The package
`services/local-bridge` declares that command as its `bin`, with `src/cli.ts` as the entry point.
Node runs the TypeScript directly. Install the command on `PATH` from the clone:

```sh
cd ~/penguin && npm install -g ./services/local-bridge
penguin-bridge   # prints the usage of every command
```

npm links the global command to the folder in the clone without copying it. The command therefore
runs the clone's current code with the dependencies `npm install` put in `~/penguin/node_modules`.
Inside the clone, `npx penguin-bridge` runs the same command without a global install.

## Registering

The deployer issues a one-time registration code for the owner, valid for 900 seconds:

```sh
curl -sS -X POST https://<worker-url>/bridges/codes \
  -H @<file holding "Authorization: Bearer <deployer token>"> -H 'Content-Type: application/json' \
  -d '{"owner":"jun","role":"owner"}'
```

The owner spends it:

```sh
penguin-bridge register --server https://<worker-url> --owner jun --code <code>
```

Registration creates the owner's Ed25519 signing key if there is none, sends the public half to
Penguin and stores the bridge token Penguin returns. The command refuses a code issued for another
owner. The deployer revokes a bridge with `DELETE /bridges/<bridge id>`; a revoked bridge's tokens
stop working and its key no longer verifies operations.

### Keys and local state

| Item | Where | Notes |
|---|---|---|
| Signing key | OS keychain, service `penguin-bridge`, account `signing-key:<owner>` | Ed25519 private JWK. `penguin-bridge key --owner <id>` prints the public half |
| Bridge token | OS keychain, account `bridge-token:<owner>` | Never printed |
| Artifacts repo tokens | Process memory only | Fetched from `POST /tokens` at push time; Git receives each through `GIT_CONFIG_*` environment variables for one command, never an argument, config file or remote URL |
| Registration record | `~/.penguin/bridge.json`, mode 0600 | Server, bridge id, owner and role; nothing secret |
| Outbound spool | `~/.penguin/spool.jsonl` | Append-only queue of operations and checkpoint pushes |
| Issues clone | `~/.penguin/issues/<hash>/` | The bridge's clone of the `issues` repo |
| Runner repository | `~/.penguin/combined/` | Runner mode only |

The keychain is macOS Keychain, Windows Credential Manager or Linux Secret Service, through
`@napi-rs/keyring` (`key-store.ts`). Every command takes `--state-dir <dir>` in place of `~/.penguin`.
The bridge sends credentials only over HTTPS; plain HTTP is accepted only for a loopback host such
as `wrangler dev`.

## Checkpoint publishing

```sh
penguin-bridge checkpoint --owner jun --project <project id> --identity @jun/reports
```

The command publishes the worktree it runs in (`--worktree <path>` names another) to the owner's fork
`penguin:owner-<owner>` (`checkpoint.ts`):

1. It builds a checkpoint commit of the worktree's tracked files as they are on disk, parented on
   `HEAD`, without touching the worktree, its index or any local ref. Untracked and ignored files are
   never published. When the fork's branch holds an earlier checkpoint that `HEAD` does not contain,
   that checkpoint becomes a second parent, so every push fast-forwards.
2. It prints a preview: the checkpoint, the destination branch and every tracked file that differs
   from the newest commit the fork already has, with line counts.
3. It asks "Publish this checkpoint? [y/N]". Only an explicit yes publishes.
4. It appends the push to the spool and pushes to `refs/heads/<branch>` of the fork, without force.
   With the fork unreachable the push stays queued and a later drain sends it.
5. It reports the checkpoint on `POST /checkpoints`, which records it as the fork's latest checkpoint
   and schedules combined runs ([huddle-flow.md](huddle-flow.md#2-combined-run-scheduling)).
6. It sends a safe checkpoint for the worktree and prints any fix task delivered to a session there.

`--consent` sets how far one yes reaches. The preview prints before every push in each mode.

| Value | One yes covers |
|---|---|
| `each-publish` | This publish only |
| `worktree` (default) | Later publishes from the same worktree by the same publisher |
| `project` | Every worktree of the repository by the same publisher |

The publisher keeps a yes in memory only. `penguin-bridge checkpoint` publishes once and exits, so
the command line asks on every publish whichever value is set.

`--fork <bare repo path>` publishes to a local bare repository instead, for working without
Penguin. `--remote` must name the same fork; any other destination is refused before Git runs.

### Agent trailer and identity checks

With `--identity @<owner>/<name>`, a checkpoint commit the bridge builds ends with a trailer that
names the agent identity whose session made it:

```text
Penguin-Agent: @jun/reports (codex)
```

The vendor comes from `penguin/identities.json` as committed at `HEAD`. A handle missing from that
file, or with no valid vendor, publishes without the trailer and prints a warning.
`--agent-trailer off` turns the trailer off for the project. The trailer carries no email.

The identity's owner is checked on every publish that names an identity, with the trailer on or off.
The handle's owner half must be the fork's owner, or, for a team identity listed with an `owners`
array, that array must include the fork's owner. Any other identity refuses the publish before the
fork is read.

## Issue command line

Owners write issue operations from the bridge. Each is signed with the bridge key, appended to the
spool, written to the bridge's clone of `issues`, committed and pushed (`issue-cli.ts`,
`issue-writer.ts`).

```sh
penguin-bridge issue create  --owner jun --title "Retention counts merged users twice" [--body <text>]
penguin-bridge issue comment --owner jun --issue 31 --body "Looking at the cutover"
penguin-bridge issue label   --owner jun --issue 31 --label scope:analytics
penguin-bridge issue assign  --owner jun --issue 31 --to @jun/reports
penguin-bridge issue review  --owner jun --issue 33 --verdict request_changes \
  --commit owner-priya@9b2f10 --reason "A limit of five still joins the tablet's users."
penguin-bridge issue state   --owner jun --issue 31 --state closed --reason "Duplicate" [--resolution cancelled]
```

| Option | Default | Meaning |
|---|---|---|
| `--as <person or @owner/name>` | The owner in person | The author; only the owner or the owner's identities verify |
| `--base-version <n>` | The number of the issue's operation files in the clone plus those still queued | The issue version the operation is based on |
| `--repo` | `penguin:issues` | A local bare repository path instead, for working without Penguin |

The default base version counts every file in the issue's folder. A rejected operation does not
advance the issue's version, so after a rejection pass `--base-version` with the version
`get_issue` or the issue page reports.

`create` writes the issue under a temporary ID, which is its own op_id, then prints it. Penguin gives the issue
a number when it applies the create; the temporary ID stays an alias, so later commands keep naming
the issue by it ([issues.md](issues.md#offline-issues-and-aliases)).

With the issues repo unreachable, the operation stays signed and queued in the spool and the command
still exits 0. The next issue command, `penguin-bridge spool drain` or `penguin-bridge spool watch`
pushes it.

## Safe checkpoints

```sh
penguin-bridge session-checkpoint [--hook]
penguin-bridge worktree-id
```

`worktree-id` prints the id an agent session in this worktree registers with. `session-checkpoint`
tells Penguin the sessions in this worktree are between steps, so waiting fix tasks and thread
notices reach them (`session-checkpoint.ts`). With `--hook` it is a PreToolUse hook for Claude Code
and Codex: it prints a hook answer only when something arrived and always exits 0, so an unreachable
Penguin never stops the agent. [mcp-setup.md](mcp-setup.md#fix-tasks-and-safe-checkpoints) has the
hook settings.

## Runner mode

One designated machine runs the bridge as the project's integration runner. The deployer issues a
code with `{"owner":"runner","role":"runner"}`. The operator registers with it:

```sh
penguin-bridge register --server https://<worker-url> --owner runner --code <code>
penguin-bridge runner --combined
```

`runner` refuses to start on a bridge registered as `owner`. Each pass, every 10,000 ms by default
(`--interval <ms>`), it:

1. Lists `GET /operations/pending` and writes each operation file at the path the operation names,
   refusing any listing whose path differs. It makes one commit and pushes once
   ([issues.md](issues.md#pending-push)).
2. With `--combined` or `--repo <path>`, also runs Penguin's test jobs in the repository at `<path>`,
   default `~/.penguin/combined`, created empty when missing:
   - claims and runs combined runs (`combined-run-pass.ts`);
   - lists and runs verification runs, pushing each merge to the Huddle repo's `integration` branch
     (`verification-run.ts`);
   - lists approved branches and pushes the Huddle repo's `approved` branch (`approval-run.ts`).

Passing `--combined` or `--repo` is the runner operator's consent to those runs and pushes. The test
jobs loop on their own, so a long test run never holds up the operation pushes. `--once` runs a
single pass of each and exits 1 when anything was refused or failed.

The runner fetches owner forks with read tokens and pushes Huddle repos with write tokens; the Worker
grants a runner bridge `write` on `huddle-<id>` repos and an owner bridge only `read`.

## Allowlisted commands

Penguin names a test only by command id, `test:<scope id>`. The bridge resolves the id to the
scope's `test_command` in `penguin/scopes.json` as committed at the pinned commit, read with
`git cat-file`, so an uncommitted or later edit cannot change what runs. An id with no scope there is
refused and never runs (`command-allowlist.ts`).

Each run happens in a throwaway detached worktree at the pinned commit, in a temporary directory,
removed afterwards; the owner's own worktrees are never read from or written to (`test-runner.ts`).
The test runner asks for consent before it creates each worktree. In runner mode, `--combined` or
`--repo` is that consent.

The command's environment leaves out every `PENGUIN_*` and `ARTIFACTS_*` variable and
`CLOUDFLARE_API_TOKEN`, so no Penguin, Artifacts or Cloudflare credential reaches a command the
repository defines.

### Colour handling

The runner finds failing tests from pytest's `FAILED <node id>` summary lines. Coloured output wraps
those lines in escape codes, so the bridge turns colour off for every command: it removes
`FORCE_COLOR`, `PY_COLORS` and `CLICOLOR_FORCE` from the environment and sets `NO_COLOR=1`. The
parser also strips ANSI escape sequences before it reads the log (`combined-run.ts`), so a test tool
that colours its output anyway still reports its failures.
