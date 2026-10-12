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
| Fixtures | `tests/test_fixtures.py` | Each fixture builds to its pinned commits; each scope's DRI is on its team; each agent changes only its person's scopes | about 2 seconds |
| Live | `tests/e2e/` | Cloudflare primitives against real Artifacts: forks and tokens, fixes written into a fork, promotion of main, the record repo, fetches over Git protocol v2 | minutes; needs Cloudflare login |

## Rule files

| File | PRD rule |
|---|---|
| `approval.test.ts` | 4.3: Penguin approves a part only when every check is clean; each failing condition sends it to a person |
| `split.test.ts` | 4.2 step 1: the contract-diff sort and the split, plan or nothing decision |
| `routing.test.ts` | Core concepts and 4.4a: teams, DRIs, the fallback order and protected paths |
| `stages.test.ts` | Section 10: the stage a feature counts under (Building, Plan, the split stages, Promoted) |
| `review.test.ts` | Section 6: the review form's refusals |
| `migration.test.ts` | 4.2 step 2: callers grouped by owner; the defining scope's own uses are not callers |
| `fixes.test.ts` | 4.2 and 4.4: patches apply exactly; rewrite rules are well formed |
| `security.test.ts` | Section 8: signed records, token scopes, line visibility, dashboard sessions |

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

## Not yet covered

These behaviours have no test since the suite was rebuilt:

- the order of writes into one fork (one write at a time, re-trial after each);
- releasing a claimed run when the check runner reports a failure, and stopping it at the limit;
- the combined-run scheduler;
- the block landing path and the record repo, until the live tests are rewritten on gn100;
- the tool-runner's claims.

The live tests in `tests/e2e/` predate the rebuild and still use the walkthrough harness. They are to
be rewritten as one test per primitive once gn100 is logged in to Cloudflare.

## Rules for adding tests

- A ticket adds the fewest tests that prove its acceptance and deletes the tests its change makes
  redundant.
- Tests run against the real system or pure functions. A fake of an external system is raised with
  the user before it is built.
- A test names the PRD rule or use case it checks in its title or header comment.
