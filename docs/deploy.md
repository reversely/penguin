# Deploy

This page is for the deployer: the person who runs Penguin's Cloudflare account, sets its secrets,
sets up the project's repos and hands each owner the codes and tokens they connect with. One
deployment serves one project. [architecture.md](architecture.md) shows what each resource does.

## Requirements

- A Cloudflare account on the Workers Paid plan, which Artifacts requires.
- Node.js 22.18 or later and the repo's dependencies (`npm install` at the repo root).
- A Wrangler login for that account: `npx wrangler login`.

## Cloudflare resources

Everything is declared in `apps/worker/wrangler.jsonc`, except the queue itself and its subscription.

| Resource | Name | Declared by | Notes |
|---|---|---|---|
| Worker | `penguin` | `wrangler.jsonc` | Entry `apps/worker/src/index.ts`, `nodejs_compat` |
| Static assets | binding `ASSETS` | `wrangler.jsonc` | The built dashboard in `apps/dashboard/dist`. The Worker runs first on every request, so it decides which paths are dashboard files and adds the security headers |
| Durable Object | `ProjectAgent` | `wrangler.jsonc` | One instance per deployment, named `<repo prefix>project` |
| Durable Object | `FeatureAgent` | `wrangler.jsonc` | One instance per feature, named `<repo prefix>project-feature-<id>`. One instance per owner-fork Huddle issue, named `<repo prefix>project-huddle-<issue>` |
| Migration | `v1` | `wrangler.jsonc` | Declares `ProjectAgent` and `HuddleAgent` with SQLite storage |
| Migration | `v2` | `wrangler.jsonc` | Renames `HuddleAgent` to `FeatureAgent`. Every instance keeps its storage, so each feature's plan and fix writes survive. `wrangler deploy` applies it once |
| Artifacts namespace | `penguin`, binding `ARTIFACTS` | `wrangler.jsonc` | Artifacts creates the namespace on the first repo create. `remote: true` points `wrangler dev` at the real service, since Artifacts has no local simulator |
| Queue | `penguin-issues-events` | `npx wrangler queues create penguin-issues-events` | The Worker is its consumer |
| Event subscription | `issues` repo, event `pushed` | The Cloudflare dashboard | See below |

### Queue subscription

Artifacts sends a `cf.artifacts.repo.pushed` event for a repo only when that repo has a subscription,
so the `issues` repo needs one. It can be made only after `POST /setup` has created the repo. On the
Cloudflare dashboard: Queues, then `penguin-issues-events`, then Subscriptions, then Subscribe to
events, with source Artifacts repo, namespace `penguin`, repo `issues` and event `pushed`.
`wrangler queues subscription create` takes no repo, so it cannot make this subscription. Check it
with:

```sh
npx wrangler queues subscription list penguin-issues-events
```

Owner forks need no subscription: bridges report checkpoints over HTTPS
(`POST /checkpoints`).

## Secrets

Set each with `npx wrangler secret put <NAME> -c apps/worker/wrangler.jsonc`, which reads the value
from standard input. Keep values out of the shell history and out of files in the repo.

| Name | Holds | Used for |
|---|---|---|
| `PENGUIN_DEPLOYER_TOKEN` | A random value the deployer keeps, such as in `~/.config/penguin/deployer-token` with mode 0600 | Bearer token for `/setup`, `/index/rebuild`, `/bridges/codes`, `DELETE /bridges/<id>`, `/mcp/tokens`. Unset, every deployer route refuses |
| `PENGUIN_OP_SIGNING_KEY` | An Ed25519 private key as a JSON Web Key | Signs every operation from MCP, the dashboard and Penguin. Generated once per deployment; replacing it makes every operation it signed fail verification on a rebuild |
| `GITHUB_OAUTH_CLIENT_SECRET` | The GitHub OAuth app's client secret | Dashboard sign-in; the root of the session cookie's signing key |

The signing key can go straight from WebCrypto into Wrangler without touching disk:

```sh
node -e 'crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  .then((pair) => crypto.subtle.exportKey("jwk", pair.privateKey))
  .then((jwk) => process.stdout.write(JSON.stringify(jwk)))' \
  | npx wrangler secret put PENGUIN_OP_SIGNING_KEY -c apps/worker/wrangler.jsonc
```

## Variables

| Name | Where | Default | Meaning |
|---|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | `vars` in `wrangler.jsonc` | none | The GitHub OAuth app's client id, which is public |
| `PENGUIN_DASHBOARD_OWNERS` | `vars` in `wrangler.jsonc` | none | `<github login>:<owner id>` pairs, comma-separated. Without it nobody can sign in |
| `PENGUIN_REPO_PREFIX` | Optional | empty | Leads every repo name and the ProjectAgent's name, so a test run's repos stay apart from production's |
| `PENGUIN_TOKEN_TTL_SECONDS` | Optional | 3600 | Lifetime of the Artifacts tokens the Worker mints, 60 to 31,536,000. A value outside the range makes `/tokens` refuse to mint |
| `PENGUIN_FIX_TOKEN_TTL_MINUTES` | `vars` in `wrangler.jsonc` | 10 | Lifetime of a write token on an affected feature's fork for one approved plan part, 1 to 60 minutes. Any other value refuses every fix token |
| `PENGUIN_PROMOTION_TOKEN_TTL_MINUTES` | `vars` in `wrangler.jsonc` | 5 | Lifetime of the write token on main a FeatureAgent mints for one promotion and revokes after the push, 1 to 15 minutes. Any other value refuses every promotion |
| `PENGUIN_SESSION_OFFLINE_SECONDS` | Optional | 90 | Seconds without an MCP call before an agent session goes offline |
| `PENGUIN_LOCAL_DEV_UNAUTHENTICATED` | `wrangler dev --var` only | unset | `true` opens the raw agent routes on a loopback hostname; ignored on any other host |
| `PENGUIN_GITHUB_BASE_URL` | Local testing only | unset | A local GitHub OAuth test double's address; honoured on a loopback hostname only |

### Dashboard sign-in

Create a GitHub OAuth app with the callback URL `https://<worker-url>/auth/github/callback`. Put its
client id in `GITHUB_OAUTH_CLIENT_ID` and its client secret in the `GITHUB_OAUTH_CLIENT_SECRET`
secret. Add one `<github login>:<owner id>` pair per person to `PENGUIN_DASHBOARD_OWNERS`; the owner
id must match `penguin/owners.json`. Penguin asks GitHub for no scope.
[dashboard.md](dashboard.md#sign-in) describes the sign-in.

## Deploying

From the repo root:

```sh
npx wrangler deploy -c apps/worker/wrangler.jsonc
```

The config's build step runs `npm run build -w @penguin/dashboard` first, so the deploy carries the
current dashboard. `GET /health` answers `{"status":"ok"}` once the Worker is up.

## Project setup

`POST /setup` with the deployer token makes the project's repos (`apps/worker/src/repos.ts`):

```sh
curl -sS -X POST https://<worker-url>/setup \
  -H @<file holding "Authorization: Bearer <deployer token>"> -H 'Content-Type: application/json' \
  -d '{"owners":["priya","jun","sam"],"source":{"url":"https://github.com/<org>/<repo>.git","branch":"main"}}'
```

| Field | Meaning |
|---|---|
| `owners` | The owner ids from the project's `penguin/owners.json`; each gets a fork `owner-<id>` |
| `source` | Optional. An HTTPS Git remote to import the base repo from. Without it the base repo starts empty |

Setup creates `base`, `issues` and one fork of `base` per owner. It reports each repo as `created`,
`imported`, `existing` or `pending` with the count of Artifacts operations it used. It returns no repo
token. Running it again creates only what is missing, so it also adds a new owner's fork.

Owner forks stay `pending` until `base` holds a commit, because a fork of an empty repo would lack the
team's main branch. When `base` started empty, push its first commit with a write token from
`npx wrangler artifacts repos issue-token base --namespace penguin --scope write`, then run setup
again.

The base repo's `main` must hold `penguin/scopes.json`. It should also hold `penguin/owners.json`
and `penguin/identities.json`. The ProjectAgent reads the first two on every operation it judges: a base
repo without a scope file has no scopes, so no review counts and no combined run is scheduled. The
fixtures' files are examples of each format (`examples/identity-unification/base/penguin/`).

## Handing out access

| For | Request | Response |
|---|---|---|
| An owner's bridge | `POST /bridges/codes` with `{"owner":"<id>","role":"owner"}` | A one-time code valid for 900 seconds; the owner runs `penguin-bridge register` |
| The integration runner | `POST /bridges/codes` with `{"owner":"runner","role":"runner"}` | A code the runner's operator registers with |
| An owner's agent sessions | `POST /mcp/tokens` with `{"owner":"<id>"}` | An MCP token, returned once; Penguin keeps only its hash |
| Revoking | `DELETE /bridges/<bridge id>`, `DELETE /mcp/tokens/<token id>` | 204 |

Every response that carries a code or token is marked `Cache-Control: no-store`. Hand each to its
owner over a private channel. [bridge-and-runner.md](bridge-and-runner.md#registering) and
[mcp-setup.md](mcp-setup.md) cover the owner's side.

## Checking the index

`POST /index/rebuild` with the deployer token rebuilds the issue index from the `issues` repo into
shadow tables and returns their row-by-row comparison with the live index. It changes nothing live
([issues.md](issues.md#the-index)).

## Teardown

Delete the project's repos with `npx wrangler artifacts repos delete <name> --namespace penguin -y`:
`base`, `issues`, each `owner-<id>` and each `huddle-<id>`. Remove the queue's consumer before
deleting the queue, then delete the Worker.
