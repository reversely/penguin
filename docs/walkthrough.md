# Use-case walkthrough

`npm run walkthrough` runs the three use cases of PRD section 1 through the real system and records
what each owner sees on the dashboard. Each use case gets its own local Worker under `wrangler dev`.
The Worker's Artifacts binding points at the real namespace under a repo prefix unique to the run.
Owners sign in through the loopback GitHub OAuth test double (`apps/worker/test/github-double.ts`).
The run deletes every repo under its prefix when the use case ends.

| Use case | Fixture |
|---|---|
| One person, two streams | `examples/identity-unification/` |
| The helpful fix | `examples/helpful-fix/` |
| The dependency bump | `examples/dependency-bump/` |

## What each use case runs

1. Each owner creates the fixture's identities on the dashboard and starts one scripted agent session
   per identity. A session is an MCP client holding the owner's token. Each owner's bridge publishes
   the owner's unfixed checkpoint, dependent owners first.
2. The runner bridge (`penguin-bridge runner --once --combined`) claims the combined run and reports
   the failing tests.
3. Penguin opens a Huddle issue with one fix sub-issue per failing test. Each affected owner's inbox
   lists it.
4. Each session reaches a safe checkpoint and reads its fix task through `get_work`. A fix that lies
   in the changing scope goes upstream with `send_upstream`. Each owner's bridge then publishes the
   fixture's fix commit. The session reports the checkpoint and links the commit.
5. The runner's verification run passes on the Huddle repo's `integration` branch.
6. Every owner whose review counts reviews each fix. On the fix sent upstream, the owner whose test it
   fixes requests changes. The request opens a thread. The fix's session replies through MCP. The
   fix's owner replies on the issue page. The reviewer approves and resolves the thread on the page.
7. The runner records the `approved` branch. Penguin then closes the Huddle as approved.

The walkthrough reads every owner, handle, scope, SHA and test ID from the fixture's `pins.json`,
`owners.json`, `scopes.json` and `identities.json` (`tests/walkthrough/support/fixture.ts`). Issue
numbers and operation ids come from Penguin's responses. `tests/walkthrough/no-literals.test.ts`, in
`npm test`, fails when the walkthrough source contains any of those values.

## Requirements

- A Wrangler login for the account that holds the Artifacts namespace (`npx wrangler login`).
- Google Chrome installed. Playwright drives it through `channel: "chrome"` and downloads no browser.
- The Python environment from `uv sync`. The runner's test commands use `.venv/bin/python`.

## Output

Playwright writes to `test-results/walkthrough/<fixture>/`:

| File | Content |
|---|---|
| `<step>-<view>.png` | One or more screenshots per step, such as `3-huddle-open-huddle.png` |
| `<fixture>.webm` | The use case's browser video |
| `runner.log` | Each runner pass's summary |
| `worker.log` | The Worker's console output, with the generated secrets removed |
| `cleanup.json` | The Artifacts repos the run deleted |

`test-results/walkthrough/report.json` holds each step's result and duration.

## Dashboard build per use case

Each use case's Worker serves a private copy of the dashboard build. `LocalStack.start` builds the
dashboard, copies `apps/dashboard/dist` into the use case's temporary folder and starts
`wrangler dev` with `--assets` pointing at the copy.

Wrangler 4.149.0 watches the assets directory of a running `wrangler dev`. When another process in
the same checkout rebuilds the dashboard, `apps/dashboard/build.ts` deletes `dist` and writes it
again. Every ASSETS fetch of the running `wrangler dev` then answers 500 with an empty body. The
processes that rebuild `dist` include `wrangler deploy`, another `wrangler dev` starting and
`npm run build -w @penguin/dashboard`. The asset worker in Miniflare turns the failure into the 500
without logging it.

A probe measured this against one `wrangler dev` with GET / every 10 ms for 30 seconds:

| Rebuild 5 seconds in | GET / answers |
|---|---|
| None | 1841 times 200 |
| A source file rewritten, so `wrangler dev` runs its own build | 1712 times 200 |
| `npm run build -w @penguin/dashboard` from another process | 301 times 200, then 1508 times 500 |
| The same rebuild, with `--assets` on a copy of the build | 1755 times 200 |

After the external rebuild, `/`, `/board`, `/app.js`, `/app.css` and the font files all answered 500.
The probe and the walkthrough runs had 1.0 to 3.5 GB of free disk. No run had more free disk to compare.

## Remote-binding errors in worker.log

`worker.log` holds lines of the form `✘ [ERROR] Error: internal error; reference = <id>` with no
stack. Penguin's Worker does not produce them. Wrangler runs the remote Artifacts binding through a
preview Worker on Cloudflare and prints that Worker's tail events into the same output
(`realishPrintLogs` in `wrangler-dist/cli.js`). Each line is one exception of one tail event.

A run with a hook on wrangler's `JSON.parse` and `console.error` traced all 294 such lines of one
run to 98 tail events. Every event was the binding's WebSocket session
(`GET /?MF-Binding=ARTIFACTS`, Upgrade: websocket) ending with outcome `loadShed` after 40 to 70
seconds of wall time, with three exceptions each. All 21 steps passed in that run. The count varies
between runs of the same code from 21 to 423 lines per run. The reference ids appear in no log of the local
`workerd` processes, including with `--verbose`.
