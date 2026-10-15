# Penguin

Penguin is a Git platform on Cloudflare for teams whose members each run their own coding agents in
one codebase. Before a change reaches main, Penguin checks it against the other people's unfinished
branches that use the code it changes. It checks only those. When a check finds a difference, the
agents on both sides settle it. Penguin then merges the change with every approved fix in one push.

## What Penguin catches

A change can merge cleanly and pass its own tests while it changes what someone else's unfinished
work does. Each developer's tests pass on their own branch. The break only appears once the change
reaches main. Penguin finds those changes before the merge:

- **Logic:** Priya's change merges a shopper's devices into one account. Jun's unfinished analytics
  dashboard now reports a lower count for a day it already published.
- **A shared helper:** Hugo's change makes `start_of_day` return UTC midnight. Elif's holiday closures
  and Sam's weekly digest, both still in progress, now use the wrong local day.
- **Data at scale:** Ines moves every price to whole cents. Penguin replays recorded orders on main
  and on each step of the change. It stops the step that changes a tax total.

## How it works

1. **Fork.** Each feature is its own fork of main in Cloudflare Artifacts. An agent works only in its
   person's fork, with a short-lived token that writes to that fork alone.
2. **Commit.** At each checkpoint, Penguin records which functions the change calls and changes. A
   Durable Object keeps that list for every running feature.
3. **Compare.** When an agent asks Penguin to check its change, Penguin looks up the branches that call
   what the change touches and replays their code twice: once on main, once with the change. Every
   difference names one call site in one branch.
4. **Patch.** The agent making the change explains each difference as intended and proposes a fix, or
   revises its own change. A difference that a later check no longer finds closes by itself.
5. **Review.** The agent that owns each affected branch, or its person, approves the fix. Penguin's
   check runner writes the approved fix into that branch with a token for that one fork.
6. **Merge.** When every difference is settled, Penguin merges the change into main in one push.

How much a person decides is set per project, from Penguin deciding alone in local development to a
person approving every part in production ([docs/review-policies.md](docs/review-policies.md)).

## Built on Cloudflare

| Piece | What Penguin uses it for |
|---|---|
| Artifacts | Main, one fork per feature and the record of every plan, approval and merge. Tokens are scoped to one repo and expire in minutes |
| Durable Objects | The ProjectAgent keeps people, sessions and the list of which branches call which functions. One FeatureAgent per feature keeps its plan, its differences and its fixes. It also makes the merge |
| Workers | The MCP endpoint agents call and the dashboard people use |
| Queues | Pushes to the issues repo reach the Worker |

## Connect your agent

Penguin works with any coding agent that speaks MCP, such as Claude Code or Codex, running on your own
machine.

1. **Get your MCP token** from the person who runs your Penguin project.
2. **Add Penguin as an MCP server.** For Claude Code:

   ```sh
   claude mcp add --transport http penguin https://<your-penguin>/mcp \
     --header "Authorization: Bearer <your token>"
   ```

   Codex and a shared `.mcp.json` are in [docs/mcp-setup.md](docs/mcp-setup.md).
3. **Install the bridge**, which publishes your checkpoints after showing you the exact changes:

   ```sh
   git clone <this repo> ~/penguin && cd ~/penguin && npm install
   npm install -g ./services/local-bridge
   ```

4. **Add the hook** from [docs/mcp-setup.md](docs/mcp-setup.md#fix-tasks-and-safe-checkpoints), so
   your agent hears about new work before its next step.

Tell your agent which feature it works on, for example: "You're working on accounts-merge. Check your
change with Penguin and deal with whatever it finds." When it has nothing left to do, it calls
`wait_for_work`. Penguin wakes it when a change reaches its branch. Codex users raise
`tool_timeout_sec` to 1260 for this ([docs/mcp-setup.md](docs/mcp-setup.md#waiting-for-new-work)).

## Use the dashboard

Sign in with GitHub. Your inbox lists what waits on you: a fix to approve for your branch, a
difference your agent could not settle, or a plan part routed to you. Each feature's page shows its
pipeline (Open, Plan, Review, Fixes written, Block checks, Promoted), the branches its change reaches
and every difference with the agents' explanations. [docs/dashboard.md](docs/dashboard.md) describes
each screen.

## Try it

- **On your machine:** `node scripts/preview/dashboard.ts --example identity-unification` serves the
  dashboard over a seeded demo project, Larder, an online grocery service. Build the dashboard first
  with `npm run build -w @penguin/dashboard`.
- **On your own Cloudflare account:** [docs/deploy.md](docs/deploy.md) sets up the Worker, its Durable
  Objects, the Artifacts namespace and the secrets.

## Documentation

[docs/README.md](docs/README.md) lists every page.
