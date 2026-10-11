# Connecting agent sessions to Penguin

An owner's Claude Code or Codex session reads the issues assigned to one of the owner's identities and
writes comments, linked commits and state changes back to them. The session reaches Penguin's MCP
endpoint, `<worker-url>/mcp`, with the owner's MCP token (setup inventory K3). The token decides whose
identities the session may use. This page covers issuing a token, connecting each agent product,
registering a session and running the Phase 3 exit check by hand and as a script.

## Prerequisites

| Item | Who provides it | Where it comes from |
|---|---|---|
| The Worker URL | The deployer | The deployed Worker, such as `https://penguin.example.workers.dev` |
| An MCP token per owner | The deployer | `POST /mcp/tokens` with the deployer token (below) |
| The identity the session works as, such as `@jun/reports` | The owner | The dashboard's Identities page, signed in as that owner |
| Dashboard sign-in for each owner | The deployer | `PENGUIN_DASHBOARD_OWNERS` in `apps/worker/wrangler.jsonc` maps each GitHub login to an owner id |

An identity's handle starts with its owner's id, so only Jun can create `@jun/reports`. Jun needs a
GitHub login in `PENGUIN_DASHBOARD_OWNERS` to sign in and create it.

A session registered for an identity receives that identity's assigned issues through `get_work` only
when the identity accepts assignments automatically. Otherwise the owner accepts each assignment first.

## Issuing an MCP token

The deployer issues one token per owner. Penguin returns the token once and keeps only its hash. Keep
the deployer token out of the command line by passing the header from a file:

```sh
umask 077
printf 'Authorization: Bearer %s\n' "$(cat ~/.config/penguin/deployer-token)" > /tmp/penguin-deployer-header
curl -sS -X POST https://<worker-url>/mcp/tokens \
  -H @/tmp/penguin-deployer-header -H 'Content-Type: application/json' \
  -d '{"owner":"jun"}' > /tmp/penguin-jun-token.json
rm /tmp/penguin-deployer-header
```

The response holds `tokenId`, `owner`, `token` and `issuedAt`. The deployer hands `token` to the owner
over a private channel and keeps `tokenId` to revoke it later with `DELETE /mcp/tokens/<tokenId>`.

## Claude Code

Claude Code connects to an HTTP MCP server with a bearer header
([Claude Code MCP](https://code.claude.com/docs/en/mcp)):

```sh
claude mcp add --transport http penguin https://<worker-url>/mcp \
  --header "Authorization: Bearer <token>"
```

The command writes the server, with the token, to `~/.claude.json` at local scope: the server loads
only in the project where the owner ran the command. `claude mcp get penguin` shows whether it
connected.

A project can instead name the server in a `.mcp.json` file at its root and read the token from the
owner's environment, so the token never sits in a file. Claude Code expands `${VAR}` in a remote
server's `url` and `headers`:

```json
{
  "mcpServers": {
    "penguin": {
      "type": "http",
      "url": "https://<worker-url>/mcp",
      "headers": { "Authorization": "Bearer ${PENGUIN_TOKEN}" }
    }
  }
}
```

Claude Code asks the owner to approve a project's `.mcp.json` server on the first run in that folder.

## Codex

Codex reads MCP servers from `[mcp_servers.<name>]` tables in `~/.codex/config.toml`, or in a trusted
project's `.codex/config.toml` ([Codex MCP](https://developers.openai.com/codex/mcp)). The
`bearer_token_env_var` key names the variable Codex reads the token from:

```toml
[mcp_servers.penguin]
url = "https://<worker-url>/mcp"
bearer_token_env_var = "PENGUIN_TOKEN"
```

`codex mcp add penguin --url https://<worker-url>/mcp --bearer-token-env-var PENGUIN_TOKEN` writes the
same table. The owner starts Codex with the token in the environment: `PENGUIN_TOKEN=<token> codex`.

For one session without changing any configuration file, the same keys go on the command line:

```sh
PENGUIN_TOKEN=<token> codex \
  -c 'mcp_servers.penguin.url="https://<worker-url>/mcp"' \
  -c 'mcp_servers.penguin.bearer_token_env_var="PENGUIN_TOKEN"'
```

In the Codex terminal UI, `/mcp` lists the connected servers and their tools.

## Registering a session

Penguin's server instructions tell the agent to call `register_session` first. The owner names the
identity in the first prompt, for example:

> Call the penguin register_session tool with identity "@jun/reports", vendor "codex", worktreeId
> "reports-retention" and branch "reports/retention". Then call get_work with the sessionId it returns.

| Argument | Value |
|---|---|
| `identity` | One of the token owner's identity handles, such as `@jun/reports` |
| `vendor` | `claude-code` or `codex` |
| `worktreeId` | The bridge's id for the worktree, or any stable name of letters, digits, `.`, `_` and `-` |
| `branch` | The branch checked out in the worktree |

`register_session` returns a `sessionId`. The agent passes it to `get_work`, `get_issue`, `post_update`
and `report_checkpoint`. Each of those calls keeps the session running. After about 90 seconds without
one, Penguin marks the session offline and the agent registers again. A registered session appears on
the board in its owner's lane under the identity, with its vendor and branch.

Penguin refuses `register_session` for an identity the token's owner does not own. The refusal reads
`forbidden` and names the identity's owner.

## Manual exit check with live sessions

These steps run the Phase 3 exit check with a live Claude Code session and a live Codex session. They
need Priya and Jun signed in to the dashboard in two browsers, plus an integration runner.

1. The deployer issues MCP tokens for Jun and for Sam, then a runner registration code with
   `POST /bridges/codes` and the body `{"owner":"runner","role":"runner"}`.
2. The runner's operator registers the runner bridge with
   `penguin-bridge register --server https://<worker-url> --owner runner --code <code>`
   and starts `penguin-bridge runner`, which pushes pending operations every 10 seconds.
3. Jun signs in to the dashboard. On the Identities page, Jun creates `@jun/reports` with
   "Accept assignments automatically" checked.
4. Jun connects a Claude Code session with Jun's token (Claude Code section) and registers it as
   `@jun/reports` with vendor `claude-code`. Jun connects a Codex session with Jun's token (Codex
   section) and registers it as `@jun/reports` with vendor `codex`. Priya's board shows both sessions
   under `@jun/reports` in Jun's lane without a reload.
5. Security: a Codex session started with Sam's token in `PENGUIN_TOKEN` asks to register as
   `@jun/reports`. The tool answers `forbidden`. No new session appears on the board.
6. Priya opens an issue and assigns `@jun/reports`. On the Board, Priya selects New issue, enters the
   title "Retention dashboard counts merged users twice", checks `@jun/reports` under Assignees and
   selects Create. The dashboard opens the new issue's page with `@jun/reports` under Assignees.
   Priya's board shows the card in Jun's lane without a reload. Jun's inbox lists the issue under
   Assignments without a reload. The issue page's Assignees panel also assigns an identity to an
   existing issue with Assign and removes an assignee with Unassign.
7. Jun asks either session to call `get_work`. The issue is in the result.
8. Jun asks the session to comment on the issue with `post_update` and to link a commit, such as
   `owner-jun@4acb1bf94cf8753569e0af7bb26955812e3aa4c6` with kind `fix`. The issue page and the board
   card show the comment and the commit without a reload.
9. On its next pass the runner prints `N pending: N pushed in commit <sha>`. The four operation files
   appear under `issues/<number>/ops/` in the issues repo. Once the push event reaches Penguin, the
   issue page stops marking those operations as waiting for the Git log.

## Scripted exit check

`tests/e2e/exit-check.test.ts` runs the same steps with JSON-RPC calls to `/mcp` in place of a live
agent. In place of the New issue form, it sends the create and assign operations the form sends to
`/api/operations`. It signs in as Priya and Jun, listens on both people's `/api/live` sockets, registers the runner
bridge with an in-memory key store and runs `penguin-bridge runner --once` passes until the operations
appear on a fresh fetch of the issues repo. It closes the issue at the end and revokes the MCP tokens
and the runner bridge it made. `npm test` skips it unless `PENGUIN_E2E_URL` is set.

| Variable | Meaning | Default |
|---|---|---|
| `PENGUIN_E2E_URL` | The Worker's origin | none; the test is skipped |
| `PENGUIN_E2E_DEPLOYER_TOKEN_FILE` | A file holding the deployer token | `~/.config/penguin/deployer-token` |
| `PENGUIN_E2E_SIGN_IN` | `github-double` for a loopback Worker, `cookies` for a deployed one | chosen from the URL |
| `PENGUIN_E2E_PRIYA_COOKIE_FILE`, `PENGUIN_E2E_JUN_COOKIE_FILE` | Files holding each person's `__Host-penguin_session` cookie value, copied from a signed-in browser | none |
| `PENGUIN_E2E_PRIYA_LOGIN`, `PENGUIN_E2E_JUN_LOGIN` | GitHub logins the test double signs in as | `priya-gh`, `jun-gh` |
| `PENGUIN_E2E_RUNNER_OWNER` | The owner id the runner bridge registers as | `runner` |
| `PENGUIN_E2E_TIMEOUT_MS` | The wait for a live message or a push | `60000` |

The test prints its timings as test diagnostics, each in milliseconds from the assign operation: to
the live messages, to `get_work` returning the issue, to the assign operation appearing in the issues
repo and to all four operations appearing there.

### Against a local Worker

The local Worker runs the real Worker and agents in `wrangler dev`, with the Artifacts binding pointed
at the real namespace. A repo prefix keeps the run's repos apart from production's. The secrets go in
an env file with mode 0600: `PENGUIN_DEPLOYER_TOKEN` (any random value), `PENGUIN_OP_SIGNING_KEY` (an
Ed25519 private JWK), `PENGUIN_REPO_PREFIX`, `PENGUIN_GITHUB_BASE_URL=http://127.0.0.1:8788`,
`GITHUB_OAUTH_CLIENT_ID=double-client`, `GITHUB_OAUTH_CLIENT_SECRET=double-secret` and
`PENGUIN_DASHBOARD_OWNERS=priya-gh:priya,jun-gh:jun,sam-gh:sam`.

```sh
node apps/worker/test/github-double.ts --port 8788
npx wrangler dev -c apps/worker/wrangler.jsonc --ip 127.0.0.1 --port 8787 --env-file <env file>
PENGUIN_E2E_URL=http://127.0.0.1:8787 PENGUIN_E2E_DEPLOYER_TOKEN_FILE=<file with the same deployer token> \
  node --test tests/e2e/exit-check.test.ts
```

The run's `/setup` call creates `<prefix>base` and `<prefix>issues`. Delete them afterwards with
`npx wrangler artifacts repos delete <name> --namespace penguin -y`. The local Worker receives no
Artifacts push events, so its operations stay marked as waiting for the Git log after the runner
pushes them.

### Against the deployed Worker

The deployed Worker needs Priya and Jun to sign in through GitHub. Each person signs in to the
dashboard in a browser, copies the `__Host-penguin_session` cookie value from the browser's developer
tools into a file with mode 0600 and passes the two files:

```sh
PENGUIN_E2E_URL=https://<worker-url> \
PENGUIN_E2E_PRIYA_COOKIE_FILE=<file> PENGUIN_E2E_JUN_COOKIE_FILE=<file> \
  node --test tests/e2e/exit-check.test.ts
```

The run writes to the production project: it creates `@jun/reports` when the identity is missing,
leaves one closed issue in the issues log and registers then revokes two MCP tokens and one runner
bridge.
