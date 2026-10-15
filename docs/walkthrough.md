# Case walkthrough

`npm run walkthrough` runs the four cases of the PRD from feature open to promotion through the real
system. It records what each person sees on the dashboard and the PRD section 11 metrics. Each case
gets its own local Worker under `wrangler dev`. The Worker's Artifacts binding points at the real
namespace under a repo prefix unique to the run. People sign in through the loopback GitHub OAuth
test double (`tests/walkthrough/support/github-double.ts`). The check runner runs in-process. The
run deletes every repo under its prefix when the case ends.

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
- **People** decide on the dashboard in Playwright's Chromium. The walkthrough presses Approve start,
  Approve revision, Request change and Send request on the inbox page as the person a case names.
  An expand's addition to a person's scope is approved with that person's session through
  `POST /api/overlaps/approve`.
  Between frames and decisions the page sits on `about:blank`, so the app's reads on each live
  message do not add remote-binding calls to the agents' own.
- **The check runner** is `penguin-bridge runner --once --combined`, run in-process between steps.

## What each case runs

1. **Open.** Every running feature's agent opens its feature, one at a time in the fixture's order.
   A start that waits on an overlap lock is approved on the dashboard by the lock's person. The agents
   then publish their first checkpoints, six at a time. When the fixture lists features promoted
   before the originating one, main then moves to the head of the last of them as setup. Larder runs
   cases 1 to 3 before case 4, so for case 4 the running features open at the base and main moves to
   the head of the last promotion before the split, as the preview seed does. The originating agent
   opens its feature, publishes its first commit and calls `whats_near`, `impact` and `check`.
2. **Plan.** The originating agent publishes its commits up to the first one the fixture marks as a
   revision and reports the last as a checkpoint, so the plan's checkpoint defines every symbol the
   parts import. It calls `propose_plan` with no parts until the facts run reports. Penguin's answer
   then names every affected place. The agent sends one part per place: the fixture's fix commit for
   a scope, or the running feature's fixture fix as a patch against the fork head the facts tested. A
   plan over the project's break limit goes back to its person. The case then ends at the returned
   plan.
3. **Advance notice.** Each affected author's agent reads its parts through `get_work` and submits the
   form from the fixture's `reviews/` for its scope. Authors approve on the dashboard. The originating
   commits that the fixture marks as revisions (`revises` in `features.json`, kind `revision` in
   `larder.json`) set the requested changes. The author asks for one change per revision commit. The
   originating agent answers each with `revise_plan_part`. The author's agent reviews again after
   each revision. A running feature that the fixture marks `midway` publishes its later checkpoint.
   It then gains a part that its person approves. A `late-starter` opens after the plan and receives
   it at open.
4. **Build.** The check runner the walkthrough starts claims each approved part, behavioural and
   mechanical, at `POST /fix-writes/claim` and writes it into the affected fork with the copied
   modules. Each agent writes only into its own feature's fork. No agent needs `penguin-bridge` on
   its path. The walkthrough waits for each write on the feature page and checks that every written
   commit's tree equals the fixture's fix tree. Each affected feature's agent reports the written
   commit as its next checkpoint.
5. **Land.** The originating agent publishes its remaining commits, calls `check` and then
   `land_feature`. The walkthrough runs every scope's test command on main's new head.

Case 4 is a split, so it runs these steps in place of steps 2 to 5:

1. **Expand.** The originating agent proposes the plan of its first checkpoint, the expand, with no
   part and with the split's rewrite rules and retiring contracts from `larder.json`. It then calls
   `land_feature` with `expand: true`. The expand adds to orders, so Penguin asks the DRI of orders
   once. That person approves on the dashboard and the agent asks again. The walkthrough waits until
   main holds the expand and runs every scope's test command there.
2. **Migrate.** The walkthrough waits for Penguin's migration plans. The midway feature publishes its
   later checkpoint, which calls a retiring function. The late starter opens and publishes. Each
   reader's builder publishes its migration. For each block in the fixture's order, the owner's
   steward joins the block Penguin opened from main, pushes the fixture's commits and submits the
   fixture's review form for a commit that has one. The steward then lands the block.
3. **Contract.** Once Penguin's contract step is approved on every retiring contract, the originating
   agent publishes its last commit, which removes the old shape. It then lands the commit.

Each case that keeps a merge plan also checks four refusals. A person who does not own a part posts
an approval of it. Its owner posts an approval that names its approver. Before landing, the
originating agent pushes to main with its fork token. After landing, it asks for a token on the
landed fork.

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
- Playwright's Chromium (`npx playwright install chromium`).
- The Python environment from `uv sync`. The runner's test commands use `.venv/bin/python`.

`PENGUIN_WORKER_LOG_LEVEL=debug` passes `--log-level debug` to `wrangler dev`, which prints the
workerd exception behind each remote-binding error. `scripts/remote-test.sh` does not run the
walkthrough; on the test machine it runs from its own checkout with `npx playwright test -c
tests/walkthrough/playwright.config.ts`.

## Output

Each case writes to `test-results/walkthrough/<fixture>/`, or to `<dir>/<fixture>/` when
`PENGUIN_WALKTHROUGH_OUT` names `<dir>`:

| File | Content |
|---|---|
| `<n>-<frame>.png` | One screenshot per [frame](#frames), as the person the frame names, numbered in capture order |
| `results.json` | The metrics, the evidence they were counted from and each frame's person, page and question |
| `metrics.md` | The metrics with their definitions, people's decisions, time per phase, fix writes and notes |
| `runner.log` | Each runner pass's summary, with remote URLs cut to the repo name |
| `worker.log` | The Worker's console output, with the generated secrets removed |
| `cleanup.json` | The Artifacts repos the run deleted and the final listing of the namespace under the case's prefix |

A case that stops partway still writes `results.json` and `metrics.md`, with the failure in its
notes. `test-results/walkthrough/report.json` holds each phase's result and duration.

### Frames

Each frame is one screenshot of the dashboard from the seat of the person it names
(`tests/walkthrough/walkthrough.spec.ts`, `support/dashboard.ts`). A frame of a feature page or an
inbox section holds that view or section only; the others hold the whole page. A frame whose
condition does not hold in a case is not captured. In a case that keeps a merge plan:

| Frame | Seat | Shows |
|---|---|---|
| `team` | The originating person | The team page |
| `start-waits` | The person whose running feature covers the area | The start in that person's Overlapping starts, before the approval; only when the start waits on a lock |
| `open` | The originating person | The feature page's Pipeline view after the first checkpoint |
| `returned` | The originating person | The inbox's returned plans, when the plan went back over the break limit; the case ends there |
| `plan` | The originating person | The feature page's Changes view with the stored plan |
| `review` | The author | The author's inbox card for the plan. With no change asked for in the case, it shows the first reviewed part its author approves |
| `approvals` | The originating person | The Changes view once the authors who ask for no change have decided |
| `review` | The author who asks for a change | The author's inbox card before the request |
| `revision` | The author | The card after a revision that still gets a change request, one per such revision |
| `revision-passes` | The author | The card after the last revision |
| `midway` | The originating person | The Changes view after the midway feature's part is approved |
| `fixes` | The originating person | The Changes view with the fixes written into other forks, when any |
| `block-checks` | The originating person | The Pipeline view after the last `check` before landing |
| `promoted` | The originating person | The whole feature page after the promotion, with its record |

Case 4 is a split, so its frames after `team`, `start-waits` and `open` follow the split's steps:

| Frame | Seat | Shows |
|---|---|---|
| `expand-waits` | The DRI of a scope the expand adds to | The expand in that person's Overlapping starts, before the approval |
| `expand` | The originating person | The Pipeline view once main holds the expand |
| `migrations` | The originating person | The Changes view with the migration plans Penguin proposed |
| `midway` | The originating person | The Changes view after the midway feature's checkpoint called a retiring function |
| `review`, `revision-passes` | The block's owner | The whole inbox once the runner recorded the review of a block commit that has a review form; `revision-passes` when the commit revises an earlier one |
| `promoted` | The originating person | The whole feature page after the contract lands, with its record |

## Dashboard build per case

Each case's Worker serves a private copy of the dashboard build. `LocalStack.start` builds the
dashboard, copies `apps/dashboard/dist` into the case's temporary folder and starts
`wrangler dev` with `--assets` pointing at the copy. A rebuild of `apps/dashboard/dist` by another
process in the same checkout, such as `npm run build -w @penguin/dashboard`, leaves each running
case's assets as they were.
