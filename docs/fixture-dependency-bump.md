# Dependency-bump fixture

The dependency-bump fixture is a small Git repository for case 3 in [design.md](design.md): the dependency
bump. Hugo owns the shared HTTP client. Hugo upgrades it from wire 1.4.0 to wire 2.0.0 to fix a
dropped request in Hugo's carrier integration. wire 2.0.0 retries a timed-out request by default.
Ana's payment webhook charges an order through that client. On the merged checkpoints a charge whose
response times out is retried. The fake payment processor then records two charges for one payment.
`examples/dependency-bump/build.py` builds the repository from the source directories next to the
builder. Every build produces the same commit SHAs. `examples/dependency-bump/pins.json` records
them.

wire is a small client library written for this fixture. Both versions live in the fixture tree as
local copies: `vendor/wire_v1/` and `vendor/wire_v2/`. `shared/http.py` imports the client from one
of them. Every scope imports the client from `shared/http.py`. The upgrade changes that one
import. Each client sends requests through a transport callable. The tests pass in-process fakes as
transports, so no test opens a network connection.

## Branches and tags

| Ref | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: two scopes declared in `penguin/scopes.json` with their owners and agent identities. `vendor/wire_v1/` holds wire 1.4.0, which sends each request once. `shared/http.py` imports it. `integrations/shipping.py` quotes carrier rates. `payments/orders.py` builds a charge request body. |
| `owner-hugo-checkpoint` (tag) | Hugo | Adds `vendor/wire_v2/` with wire 2.0.0, which retries a timed-out request up to 2 more times. `shared/http.py` imports wire 2.0.0. `integrations/tests/test_shipping.py` adds `test_quote_survives_one_dropped_request`. |
| `owner-ana-checkpoint` (tag) | Ana | The order-placed webhook in `payments/webhooks.py` with `test_webhooks.py`. `payments/tests/fake_processor.py` is the fake payment processor. It records each charge. It answers a repeated `Idempotency-Key` header with the first response and makes no new charge. |
| `owner-hugo` | Hugo | The same commit as `owner-hugo-checkpoint`. Hugo makes no fix commit. |
| `owner-ana` | Ana | On `owner-ana-checkpoint`: the webhook sends `Idempotency-Key: charge-<order id>` with each charge request |

Hugo's scope `platform` owns the paths `shared/`, `vendor/` and `integrations/`. Ana's scope
`payments` owns `payments/`. It declares a dependency on `platform` because it imports
`shared.http`. Each checkpoint starts from `main`. Ana's fix commit starts from Ana's checkpoint.
Each owner's commit changes only paths in that owner's scope. Every scope's tests pass on each
checkpoint alone. They also pass on `owner-ana` alone, which still uses wire 1.4.0. `pins.json`
records the SHA of every branch head and tag. It also maps the failing test to the commit that fixes
it.

## Expected failures

Merging the two checkpoints fails one test in Ana's scope. The `platform` tests pass on the merged
tree. The case names no test ID.

| Pytest node ID | Merged tree | Failure |
|---|---|---|
| `payments/tests/test_webhooks.py::test_timed_out_charge_is_charged_once` | `owner-hugo-checkpoint` with `owner-ana-checkpoint` | The fake processor charges order `ord_1003`. Its response is lost, so the client sees a timeout. wire 2.0.0 sends the same request again. The request carries no idempotency key, so the processor charges the order a second time. The test fails with `AssertionError: 2 charges for one payment of order ord_1003`. |

On Ana's checkpoint alone, wire 1.4.0 raises the timeout to the webhook. The webhook records the
order as unconfirmed. The processor holds one charge.

## Fixes

The fix follows case 3. Ana's session adds idempotency keys to the payment calls.
Hugo keeps the upgrade.

| Pytest node ID | Fix commit | Fix |
|---|---|---|
| `payments/tests/test_webhooks.py::test_timed_out_charge_is_charged_once` | `owner-ana` | `handle_order_placed()` sends `Idempotency-Key: charge-<order id>`. The retry carries the same key. The fake processor returns the first charge's response without charging again. The order is paid once. |

Ana reviews the fix in Ana's scope. Hugo follows the issue because the upgrade came from Hugo's
scope.

## Under the new procedure

In the approved design ([design.md](design.md#procedure)) this case runs as follows:

1. **Open.** Hugo's agent opens "Upgrade the HTTP client" to fix a bug in Hugo's integration.
   Penguin's dependency diff shows that Ana's payments scope uses the library.
2. **Plan.** wire 2.0.0 retries failed requests by default. Ana's declared invariant is "a payment
   is charged at most once". Penguin's side-by-side run with a simulated timeout shows a payment call
   made twice. Hugo's agent proposes idempotency keys on Ana's payment calls.
3. **Advance notice.** Ana's agent fills in the review form. The rerun shows one charge. Ana
   approves.
4. **Build.** Hugo's agent writes the idempotency keys into Ana's existing fork. Today Ana's session
   makes that fix (`owner-ana`).
5. **Block promotion.** The upgrade and Ana's fix reach main in one promotion. Main never holds the
   upgrade without the keys. Ana is asked once.

Before it can run this way, the fixture needs three additions:

- `penguin/invariants.json` in the base commit, with the payments invariant above
- contracts per scope in `penguin/scopes.json`, starting with the `shared/http.py` client
- Ana's work as a running feature: a fork of `main` in place of the `owner-ana-checkpoint` tag

## Manual reproduction

The steps need Git 2.38 or later for `git merge-tree --write-tree`. They also need Python 3.11 or
later with pytest. The test commands are the `test_command` values in `penguin/scopes.json`, run
from the root of the tree under test.

1. From the Penguin checkout, install the environment and put its Python first on `PATH`:

   ```sh
   uv sync
   export PATH="$PWD/.venv/bin:$PATH"
   ```

2. Build the fixture into a new directory and compare the refs with `pins.json`:

   ```sh
   python examples/dependency-bump/build.py /tmp/penguin-dependency-bump
   cat examples/dependency-bump/pins.json
   ```

   The builder prints one line per branch and tag: the ref name and its commit SHA.

3. Check each checkpoint alone. For each tag and for `owner-ana`, extract the ref into its own
   directory and run the two scope test commands:

   ```sh
   cd /tmp/penguin-dependency-bump
   mkdir ../owner-ana-checkpoint
   git archive owner-ana-checkpoint | tar -x -C ../owner-ana-checkpoint
   cd ../owner-ana-checkpoint
   python -m pytest shared integrations
   python -m pytest payments
   cd /tmp/penguin-dependency-bump
   ```

   Every command exits 0.

4. Merge the two checkpoints and run every scope's tests on the merged tree:

   ```sh
   git merge-tree --write-tree owner-hugo-checkpoint owner-ana-checkpoint
   mkdir ../merged-checkpoints
   git archive <tree SHA printed above> | tar -x -C ../merged-checkpoints
   cd ../merged-checkpoints
   python -m pytest shared integrations
   python -m pytest payments -rf
   cd /tmp/penguin-dependency-bump
   ```

   `git merge-tree` prints a single tree SHA because the merge has no conflicts. The `platform` run
   exits 0. The payments run reports `1 failed, 3 passed`. Its short test summary lists this test
   as `FAILED`:

   ```text
   payments/tests/test_webhooks.py::test_timed_out_charge_is_charged_once
   ```

5. Merge Hugo's branch with Ana's fixed branch the same way and run every scope's tests:

   ```sh
   git merge-tree --write-tree owner-hugo owner-ana
   mkdir ../combined
   git archive <tree SHA printed above> | tar -x -C ../combined
   cd ../combined
   python -m pytest shared integrations
   python -m pytest payments
   ```

   Every command exits 0.

`uv run pytest -m slow` runs the same steps in `tests/test_dependency_bump_reproduction.py`. It
asserts that every scope passes on each checkpoint alone and on `owner-ana` alone. It asserts that
the merged checkpoints fail exactly the test above with the two-charge message. It asserts that the
combined run on Hugo's branch and Ana's fixed branch passes. It also asserts that `pins.json` maps
the test to its fix commit. Finally it asserts that each owner's commit changes only that owner's
scope paths.

## Changing the fixture

A change to a source directory under `examples/dependency-bump/` changes the SHA of the commit built
from it. It also changes the SHA of every commit that starts from that commit. Run
`uv run pre-commit run --all-files` before rebuilding, because ruff can rewrite a fixture source
file. Then rebuild into an empty directory and copy the printed SHAs into the `branches`, `tags` and
`fixes` objects of `pins.json`. `tests/test_dependency_bump_builder.py` fails until `pins.json`
matches a fresh build. The detect-secrets hook reads each SHA in `pins.json` as a possible secret.
Run `uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record
the new SHAs as known values.
