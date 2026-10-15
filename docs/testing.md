# Testing

This page describes what Penguin's tests prove and where each kind lives. The suite is built from the
PRD (`docs/prd.md`, version 0.5). Each test checks one rule the PRD states, one use case's outcome or
one Cloudflare primitive. A test whose subject leaves the product is deleted with it.

## Layers

| Layer | Where | What it proves | Runs in |
|---|---|---|---|
| Rules | `tests/rules/` | One decision rule per test, run as a pure function with no I/O | under a second |
| Copy | `apps/dashboard/test/copy-style.test.ts` | No dashboard string uses a house-style banned word or pattern | under a second |
| Use cases | `tests/cases/cases.test.ts` | The four PRD use cases run in order on one build of Larder (`examples/money-minor-units`), through Penguin's own code with real git and pytest: who is asked, what Penguin approves, who is told, case 3's dependency diff, the caller replay's `differs` for case 1's and case 3's affected features before Penguin's update (with case 3's second payout and charge as effects) with `unaffected` for case 3's after it, that case 2's agent answers both differences `revising` and its revision's replay shows both callers `unaffected`, each confirmed by its worktree's builder, with no plan and no write into another fork, that cases 1 and 3 run the caller protocol (each unaffected caller confirmed by its worktree's builder, each difference explained with the case's words and approved, each write into a receiving fork after its approval), that cases 1 to 3 each write their approved fixes, copy the originating change's modules into each affected fork before the land is asked, pass every block check and are promoted in order, and for case 4 that main moves block by block until no caller is left. Case 1's plan is also routed under each of the four stages of the review policy. The starts of cases 1 to 3 open with no owner asked: Penguin approves each and tells its owner ([review-policies.md](review-policies.md)). Case 1's feature page and Jun's inbox are rendered on the server (`tests/cases/render.tsx`, bundled with esbuild) and must name each kind of validation on its results and each route of a decision or write | about 10 minutes on gn100 |
| Analysis tools | `tests/test_analysis.py` | Each deterministic tool on a small real repository: the impact graph and contract diff, a batch request that fails alone, the codemod, the dependency diff, side-by-side runs and the caller replay's pytest plugin (calls, outcomes, effects, capped and approximate values) | about 2 seconds |
| Fixtures | `tests/test_fixtures.py` | Each fixture builds to its pinned commits; each scope's DRI is on its team; each agent changes only its person's scopes; on Larder, each merged tree of cases 1 to 3 fails exactly its case's tests and passes once the case's fix or revision is in; each fork Penguin updates in cases 1 and 3 holds the originating change's modules byte for byte, passes its own tests alone and takes the promoted change with no conflict | about 4 seconds, plus a Larder build in the fast run |
| Live | `tests/e2e/` | Cloudflare primitives against real Artifacts: forks and tokens, fixes written into a fork, promotion of main, the record repo, fetches over Git protocol v2 | minutes; needs Cloudflare login |

## Rule files

| File | PRD rule |
|---|---|
| `approval.test.ts` | 4.3: Penguin approves a part only when every check is clean; each failing condition sends it to a person; a part's trial runs on the originating fork's newest revision |
| `split.test.ts` | 4.2 step 1: the contract-diff sort and the split, plan or nothing decision |
| `routing.test.ts` | Core concepts and 4.4a: teams, DRIs, the fallback order and custom path rules, with `protected_paths` read as `custom_paths` |
| `stages.test.ts` | Section 10: the stage a feature counts under (Building, Plan, the split stages, Promoted) |
| `review.test.ts` | Section 6: the review form's refusals |
| `migration.test.ts` | 4.2 step 2: callers grouped by owner; the defining scope's own uses are not callers |
| `fixes.test.ts` | 4.2 and 4.4: patches apply exactly; rewrite rules are well formed; Penguin copies only files the originating change added or changed; each Larder fork gets the modules it imports from that change |
| `facts.test.ts` | 4.2 step 2 and 4.5: a test a running feature's fork already fails without the change is no break in the facts run and fails no block check |
| `security.test.ts` | Section 8: signed records, token scopes, line visibility, dashboard sessions; only a team lead changes the review policy, admin mode locks it, a forged policy record is refused, no policy approves a part whose tests failed and a policy signed under an old preset name reads as its new name |
| `fork-writes.test.ts` | 4.4: writes into one fork take turns in approval order, each tried again on the head the last one moved |
| `module-copies.test.ts` | 4.4: a behavioural part gets a copy write after its own write; each copy write refreshes a module copied at an earlier revision; a copy write of a revision the change moved past is withdrawn; a land waits until each affected fork holds the current revision; a fork that changed a copied module goes back to the originating agent with its lines; a revision holding those lines is copied over them |
| `run-failures.test.ts` | Section 7: a failed run is freed at once and stops at the project's failure limit |
| `tool-runs.test.ts` | 5.2: only the check runner reports a tool result, once, for the request's own checkpoint |
| `caller-items.test.ts` | The caller protocol (#188): a check's replay opens an item per running feature and contract in its verdict's first state; only the receiving agent confirms, approves or rejects and only the originating agent proposes or explains; two rejections, an unanswered item and Production send an item to the worktree owner; a replay that changes the calls resets an item and one that no longer reaches it withdraws it; a fix token and a runner write into the fork wait for the receiving side's approval; a land with an open item is refused `callers_pending`, including one whose items its block run opened with no prior check (#190); only the item's two sides read its context packet, which carries the other agent's words under `personWritten`; every transition is a signed record. #189: a confirmation is refused for a run that is not the item's or has a call that did not match; an explanation for a call left out, an unknown call id or an incidental call sent to review; a review for evidence the replay did not run, from a test the change added or edited or from a test neither on main nor written by the receiving feature; the calls past the list are answered as one group with their exact count; a refusal stays on the item until it moves; `testStandingOf` reads a test's standing from the merge base's tree and both changes' files, keeping the earlier tests of a file the change only appends tests to |
| `get-work.test.ts` | #206: `get_work` for case 1's Priya after her check and plan answers under 20,000 characters, names every caller item and plan part with its next action and reads no caller packet or tool outcome; `get_work_item` answers a listed entry's details to its session alone and `not_found` for any other entry |
| `wait-for-work.test.ts` | #210: a waiting session answers as soon as a caller item opens on its worktree, with only the new entry; with nothing new for it, a wait answers `nothing_yet` at its timeout after a progress notification at the start and after each round of at most a minute; another owner's wait on the session is refused; the ProjectAgent's signal ends a round only on a change or at its timer |
| `caller-rules.test.ts` | Rule fixes for broken callers (#209): the originating agent states a rule, checked as a plan's rewrite rule; once the receiving agent approves it, one runner write into that fork carries the rule, its call sites' files and the module copies, and the verify part's copy-only write is withdrawn; a commit that changes another file is refused; the kept commit marks the item `written` with its rewritten lines and the land goes past `copy_not_written` and `callers_pending`; a rule that rewrites nothing makes no write and returns the item as `broken` with `rule_matches_nothing` |
| `combined-runs.test.ts` | #198: a checkpoint in a depended-on scope that changes a function one fork calls schedules one combined run, from the caller list; with no list of the checkpoint stored, every feature in a dependent scope is scheduled as before. #200: a feature checkpoint's Huddle reads its trigger from the feature's fork; a feature whose list predates its latest checkpoint goes by scope dependencies; a declared area folder holding a changed file is reached; a reached feature without a current list keeps its person's dependent scopes; a feature that lands or is closed loses its caller list |
| `caller-replay.test.ts` | 5.1, the caller replay: one test per verdict (`unaffected`, `differs`, `broken`, `unknown_reach`) from recordings shaped as the plugin writes them; ids stay the same across runs of the same trees; Penguin refuses a section whose caller names a missing run, whose verdict its calls contradict, whose value is over its cap or whose run replays a fork the block did not name |

## Running

| Command | Runs |
|---|---|
| `npm test` | the fast tier: rules, copy check, walkthrough guard |
| `npm run test:copy` | the copy check |
| `npm run test:slow` | the four use cases on Larder |
| `npm run test:live` | the live Cloudflare tests (each skips without its `PENGUIN_*_E2E` flag) |
| `uv run pytest` | the analysis tools and fixtures; `-m "not slow"` leaves out the fixture builds |

`scripts/remote-test.sh` runs any of them on the test machine (gn100). The tiers are listed in
`scripts/test.mjs`.

## Live tests

Each live test starts the Worker under `wrangler dev`, uses real Artifacts under a prefix unique to the
run and deletes its repositories at the end.

| File | Flag | What it proves |
|---|---|---|
| `runner-fetch.test.ts` | `PENGUIN_FETCH_E2E` | The check runner fetches 20 forks into one repository over Git protocol v2 |
| `block-landing.test.ts` | `PENGUIN_BLOCK_E2E` | A block's merge commit is pushed to main and the base repository moves |
| `expand-promotion.test.ts` | `PENGUIN_EXPAND_E2E` | An expand checkpoint is promoted to main on its own |
| `record-repo.test.ts` | `PENGUIN_RECORD_E2E` | Signed records are committed to the record repository |
| `edit-task-run.test.ts` | `PENGUIN_EDIT_E2E` | A person's bridge runs an edit task with `claude -p` and publishes the result after consent |
| `review-task-run.test.ts` | `PENGUIN_REVIEW_E2E` | Each author's bridge fills in a review form with `claude -p` through Penguin's MCP server |

The last two need Claude Code logged in on the machine that runs them, so they run on a person's laptop; the test machine runs the others. `tests/walkthrough` runs the four use cases through the same stack (docs/walkthrough.md).

Combined runs and Huddles predate PRD 0.5. Their code is still wired into the ProjectAgent until its
removal. Only the choice of a checkpoint's targets has tests (`combined-runs.test.ts`).

## Rules for adding tests

- A ticket adds the fewest tests that prove its acceptance and deletes the tests its change makes
  redundant.
- Tests run against the real system or pure functions. A fake of an external system is raised with
  the user before it is built.
- A test names the PRD rule or use case it checks in its title or header comment.
