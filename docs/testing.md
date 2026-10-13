# Testing

This page describes what Penguin's tests prove and where each kind lives. The suite is built from the
PRD (`docs/prd.md`, version 0.5). Each test checks one rule the PRD states, one use case's outcome or
one Cloudflare primitive. A test whose subject leaves the product is deleted with it.

## Layers

| Layer | Where | What it proves | Runs in |
|---|---|---|---|
| Rules | `tests/rules/` | One decision rule per test, run as a pure function with no I/O | under a second |
| Copy | `apps/dashboard/test/copy-style.test.ts` | No dashboard string uses a house-style banned word or pattern | under a second |
| Use cases | `tests/cases/cases.test.ts` | Each of the four PRD use cases on its fixture, through Penguin's own code with real git and pytest: who is asked, what Penguin approves, who is told, and for case 4 that main moves block by block until no caller is left | about 5 minutes on gn100 |
| Analysis tools | `tests/test_analysis.py` | Each deterministic tool on a small real repository: the impact graph and contract diff, the codemod, the dependency diff and side-by-side runs | about 2 seconds |
| Fixtures | `tests/test_fixtures.py` | Each fixture builds to its pinned commits; each scope's DRI is on its team; each agent changes only its person's scopes; on Larder, each merged tree of cases 1 to 3 fails exactly its case's tests and passes once the case's fix is in | about 4 seconds |
| Live | `tests/e2e/` | Cloudflare primitives against real Artifacts: forks and tokens, fixes written into a fork, promotion of main, the record repo, fetches over Git protocol v2 | minutes; needs Cloudflare login |

## Rule files

| File | PRD rule |
|---|---|
| `approval.test.ts` | 4.3: Penguin approves a part only when every check is clean; each failing condition sends it to a person; a part's trial runs on the originating fork's newest revision |
| `split.test.ts` | 4.2 step 1: the contract-diff sort and the split, plan or nothing decision |
| `routing.test.ts` | Core concepts and 4.4a: teams, DRIs, the fallback order and protected paths |
| `stages.test.ts` | Section 10: the stage a feature counts under (Building, Plan, the split stages, Promoted) |
| `review.test.ts` | Section 6: the review form's refusals |
| `migration.test.ts` | 4.2 step 2: callers grouped by owner; the defining scope's own uses are not callers |
| `fixes.test.ts` | 4.2 and 4.4: patches apply exactly; rewrite rules are well formed |
| `facts.test.ts` | 4.2 step 2: a test a running feature's fork already fails without the change is no break |
| `security.test.ts` | Section 8: signed records, token scopes, line visibility, dashboard sessions |
| `fork-writes.test.ts` | 4.4: writes into one fork take turns in approval order, each tried again on the head the last one moved |
| `run-failures.test.ts` | Section 7: a failed run is freed at once and stops at the project's failure limit |
| `tool-runs.test.ts` | 5.2: only the check runner reports a tool result, once, for the request's own checkpoint |

## Running

| Command | Runs |
|---|---|
| `npm test` | the fast tier: rules, copy check, walkthrough guard |
| `npm run test:copy` | the copy check |
| `npm run test:slow` | the four use cases |
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
removal and has no tests.

## Rules for adding tests

- A ticket adds the fewest tests that prove its acceptance and deletes the tests its change makes
  redundant.
- Tests run against the real system or pure functions. A fake of an external system is raised with
  the user before it is built.
- A test names the PRD rule or use case it checks in its title or header comment.
