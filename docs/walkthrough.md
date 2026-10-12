# Case walkthrough

`npm run walkthrough` runs the four cases of the PRD from feature open to promotion through the real
system. It records what each person sees on the dashboard and the PRD section 11 metrics. Each case
gets its own local Worker under `wrangler dev`. The Worker's Artifacts binding points at the real
namespace under a repo prefix unique to the run. People sign in through the loopback GitHub OAuth
test double (`apps/worker/test/github-double.ts`). The check runner runs in-process. The run deletes
every repo under its prefix when the case ends.

| Case | Fixture |
|---|---|
| 1. One person, two streams | `examples/identity-unification/` |
| 2. The helpful fix | `examples/helpful-fix/` |
| 3. The dependency bump | `examples/dependency-bump/` |
| 4. Money in minor units | `examples/money-minor-units/` |

The walkthrough finds the cases itself: every folder under `examples/` with a `features.json` or a
`larder.json`, ordered by base commit date and then by size. `PENGUIN_WALKTHROUGH_CASES` picks cases
by folder name, separated by commas.

## Who acts

- **Agents** are scripted MCP sessions, one per feature. Each registers as the feature's identity,
  opens the feature, pushes the fixture's commits to the feature's fork with the token Penguin minted
  and calls the tools a live agent calls.
- **People** decide on the dashboard in Google Chrome. The walkthrough presses Approve start,
  Approve revision, Request change and Send request on the inbox page as the person a case names.
- **The check runner** is `penguin-bridge runner --once --combined`, run in-process between steps.

## What each case runs

1. **Open.** Every running feature's agent opens its feature, one at a time in the fixture's order.
   A start that waits on an overlap lock is approved on the dashboard by the lock's person. The agents
   then publish their first checkpoints, six at a time. Each feature the fixture promotes first lands
   through `land_feature`. The originating agent opens its feature, publishes its first commit and
   calls `whats_near`, `impact` and `check`.
2. **Plan.** The originating agent pushes the fixture's fix commits for code on main into its fork.
   It calls `propose_plan` with no parts until the facts run reports. Penguin's answer then names every
   affected place. The agent sends one part per place: the fixture's fix commit for a scope, or the
   running feature's fixture fix as a patch against the fork head the facts tested. It then reports
   its pushed commits as a checkpoint. A plan over the project's break limit goes back to its person.
   The case then ends at the returned plan.
3. **Advance notice.** Each affected author's agent reads its parts through `get_work` and submits the
   form from the fixture's `reviews/` for its scope. Authors approve on the dashboard. The originating
   commits that the fixture marks as revisions (`revises` in `features.json`, kind `revision` in
   `larder.json`) set the requested changes. The author asks for one change per revision commit. The
   originating agent answers each with `revise_plan_part`. The author's agent reviews again after
   each revision. A running feature that the fixture marks `midway` publishes its later checkpoint.
   It then gains a part that its person approves. A `late-starter` opens after the plan and receives
   it at open.
4. **Build.** The originating agent writes each approved behavioural part into the affected fork with
   `fix_token`, `penguin-bridge fix-write` and `report_fix_write`. The check runner writes each
   mechanical part. The walkthrough checks that every written commit's tree equals the fixture's own
   fix tree. Each affected feature's agent reports the written commit as its next checkpoint.
5. **Land.** The originating agent publishes its remaining commits, calls `check` and then
   `land_feature`. The walkthrough runs every scope's test command on main's new head.

Each case also runs two refusals. A person who does not own a part posts an approval of it. Its owner
posts an approval that names its own approver. Before landing, the originating agent pushes to main
with its fork token. After landing, it asks for a token on the landed fork.

The walkthrough reads every person, handle, scope, feature, commit, test and review form from the
case's fixture (`tests/walkthrough/support/fixture.ts`). Part ids and numbers come from Penguin's
answers. `tests/walkthrough/no-literals.test.ts`, in `npm test`, fails when the walkthrough source
contains any of those values. A value that is also a key of the data files' format, such as a scope
named like a field, is left out of that check.

## Metrics

`support/metrics.ts` counts each metric from what the run recorded:

| Metric | Counted from |
|---|---|
| Main breaks | Promotions after which any scope's test command failed on main's new head |
| People touched | `approve_plan_part`, `request_plan_change` and `approve_overlap` records on the feature, by person; reviews whose record raised an exception |
| Deterministic share | The failing checks of the originating agent's first `check` run at ladder steps 1 to 3, over those at steps 4 and 5; the plan's mechanical and behavioural parts; who wrote each fix |
| Agent calls per resolution | MCP tool calls of every agent from the first `check` request through the promotion, `get_work` left out, over the failing checks of that first `check` run |
| Plan accuracy | Places the facts named when the plan was proposed, over those plus the `plan_part_added` records |

## Requirements

- A Wrangler login for the account that holds the Artifacts namespace (`npx wrangler login`).
- Google Chrome installed. Playwright drives it through `channel: "chrome"` and downloads no browser.
- The Python environment from `uv sync`. The runner's test commands use `.venv/bin/python`.

## Output

Each case writes to `test-results/walkthrough/<fixture>/`, or to `<dir>/<fixture>/` when
`PENGUIN_WALKTHROUGH_OUT` names `<dir>`:

| File | Content |
|---|---|
| `<n>-<frame>.png` | One screenshot per frame of [demo-story.md](demo-story.md), as the person the frame names |
| `results.json` | The metrics, the evidence they were counted from and each frame's person and question |
| `metrics.md` | The metrics with their definitions, people's decisions, time per phase, fix writes and notes |
| `runner.log` | Each runner pass's summary, with remote URLs cut to the repo name |
| `worker.log` | The Worker's console output, with the generated secrets removed |
| `cleanup.json` | The Artifacts repos the run deleted |

A case that stops partway still writes `results.json` and `metrics.md`, with the failure in its
notes. `test-results/walkthrough/report.json` holds each phase's result and duration.

## Where the cases stop

| Case | Result |
|---|---|
| 1 | Promoted. Jun asks for two changes on the part for analytics' code on main |
| 2 | Promoted |
| 3 | The block failed at land on a dependency diff that failed main and Ana's fork. The dependency diff is now a passing fact. `tests/integration/dependency-bump-block.test.ts` passes the block with Ana's fix in Ana's fork. The walkthrough has not run the case since |
| 4 | The block run of the promotion the fixture makes before Ines opens stops on the check runner. The runner fetches the 38 forks into one repository with Git protocol version 1. Once that repository holds 14 forks, Artifacts answers each further fetch with `fetch-pack: protocol error: bad band #78`. The same fetches with protocol version 2 succeed |

In case 4 the walkthrough plays the one-block attempt only. It reads the wave features (role `wave`)
and each running feature's waves fix (a commit with `after`, beside the branch) but opens none of
them.

A check runner pass that stops a run partway keeps the run claimed until its 30-minute lease ends.
The walkthrough stops the case at the first such report and names it in the case's notes.

## Dashboard build per case

Each case's Worker serves a private copy of the dashboard build. `LocalStack.start` builds the
dashboard, copies `apps/dashboard/dist` into the case's temporary folder and starts
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
