# Dependency-bump fixture

The dependency-bump fixture is a small Git repository for case 3 in [the README](../README.md#use-cases): the dependency
bump. Hugo owns the shared HTTP client. Hugo upgrades it from wire 1.4.0 to wire 2.0.0 to fix a
dropped request in Hugo's carrier integration. wire 2.0.0 retries a timed-out request by default.
Ana's payment webhook charges an order through that client. On the merged checkpoints a charge whose
response times out is retried. The fake payment processor then records two charges for one payment.
`examples/dependency-bump/build.py` builds the repository from the source directories next to the
builder. `examples/dependency-bump/features.json` lists the base commit and each feature: its id,
owner, role, fork branch, declared area and commits. Every build produces the same commit SHAs. `examples/dependency-bump/pins.json` records
them.

wire is a small client library written for this fixture. Both versions live in the fixture tree as
local copies: `vendor/wire_v1/` and `vendor/wire_v2/`. `shared/http.py` imports the client from one
of them. Every scope imports the client from `shared/http.py`. The upgrade changes that one
import. Each client sends requests through a transport callable. The tests pass in-process fakes as
transports, so no test opens a network connection.

## Branches and tags

| Ref | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: two scopes declared in `penguin/scopes.json` with their owners, agent identities and contracts. `penguin/invariants.json` declares the payments invariant. `vendor/wire_v1/` holds wire 1.4.0, which sends each request once. `shared/http.py` imports it. `integrations/shipping.py` quotes carrier rates. `payments/orders.py` builds a charge request body. |
| `owner-hugo-checkpoint` (tag) | Hugo | Adds `vendor/wire_v2/` with wire 2.0.0, which retries a timed-out request up to 2 more times. `shared/http.py` imports wire 2.0.0. `integrations/tests/test_shipping.py` adds `test_quote_survives_one_dropped_request`. |
| `owner-ana-checkpoint` (tag) | Ana | The order-placed webhook in `payments/webhooks.py` with `test_webhooks.py`. `payments/tests/fake_processor.py` is the fake payment processor. It records each charge. It answers a repeated `Idempotency-Key` header with the first response and makes no new charge. `payments/tests/charge_replay.py` replays a placed order against it. The penguin files add the two payments contracts and the examples file `payments/examples/placed_orders.json`. |
| `owner-hugo` | Hugo | The same commit as `owner-hugo-checkpoint`. Hugo makes no fix commit. |
| `owner-ana` | Ana | On `owner-ana-checkpoint`: the webhook sends `Idempotency-Key: charge-<order id>` with each charge request |

Hugo's scope `platform` owns the paths `shared/`, `vendor/` and `integrations/`. Ana's scope
`payments` owns `payments/`. It declares a dependency on `platform` because it imports
`shared.http`. Each feature is a fork of `main`. Ana's fix commit starts from Ana's checkpoint.
Each owner's commit changes only paths in that owner's scope. Ana's checkpoint also changes the
payments entries of the penguin files. Every scope's tests pass on each
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

## Invariants, contracts and features

The base commit's `penguin/invariants.json` declares one protected invariant for Ana's scope, in the
format in [design.md](design.md#invariants-and-examples): `charged-at-most-once`, "A payment is
charged at most once". `main` has no webhook, so `main` names no examples file. Ana's fork adds
`payments/examples/placed_orders.json` with three recorded orders: one the processor answers at
once, a declined card and an order whose charge response times out.

The test the upgrade breaks, `test_timed_out_charge_is_charged_once`, has the one-line docstring
"A payment is charged at most once." A merge plan states the break in the invariant's words.

Each recorded order runs `charges_for_placed_order` in `payments/tests/charge_replay.py`. The
function places the order through `handle_order_placed` against the fake processor. The processor
loses as many responses as the case names. The function returns the processor's charges for the
order, so a second charge shows in the side-by-side run.

`penguin/scopes.json` declares each scope's contracts. Platform declares `quote` and the client
types `Client`, `Request`, `Response` and `Timeout` in `shared/http.py`. Payments declares `Order` and
`charge_body`. Ana's checkpoint adds `handle_order_placed` and `charges_for_placed_order`.

`features.json` lists Hugo's feature "Upgrade the HTTP client" as the originating feature on the
fork `owner-hugo`. Ana's order-placed webhook (`owner-ana`) is the running feature.

## Impact and review on this fixture

The results below come from `penguin-bridge impact`, `penguin-bridge review` and
`penguin-bridge check` on a fresh build. A review compares Ana's checkpoint with a block tree: an Ana
commit with Hugo's head merged onto it.

`penguin-bridge impact --base main --head owner-hugo-checkpoint --fork ana=owner-ana-checkpoint:payments`
reports `Client`, `Client.__init__` and `Client.post` in `shared/http.py` as modified, now from
`vendor.wire_v2`, under the contract `shared/http.py::Client`. The new `retries` parameter of
`Client.__init__` has a default, so the report marks the signature compatible. Ana's fork uses the
client, so its tests run.

| Review | Base | Fork | Side-by-side differences | Verdict and exceptions |
|---|---|---|---|---|
| Payments | `owner-ana-checkpoint` | `owner-hugo-checkpoint` merged onto it | The order whose charge response times out has one charge on the base and two on the fork | Accepted. The reported break goes to Ana as a `broken_invariant`. The difference also goes to Ana as a `protected_difference` |
| Payments | `owner-ana-checkpoint` | `owner-hugo` merged onto `owner-ana` | None: the timed-out order has one charge on both sides | Accepted with `test_timed_out_charge_is_charged_once` as evidence. No exception |

`penguin-bridge check` fails the dependency diff on every merged tree, because `shared.http` moves
from wire 1.4.0 to wire 2.0.0. On Ana's checkpoint it also fails `test_timed_out_charge_is_charged_once`.
On `owner-ana` the tests pass. Overlap, merge, lint, format and the type check pass on every merged
tree.

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
`fixes` objects of `pins.json`. A new commit goes into `features.json`. `examples/ruff.toml` makes
ruff in this repository sort the fixture's imports as ruff does in the built repository. `tests/test_dependency_bump_builder.py` fails until `pins.json`
matches a fresh build. The detect-secrets hook reads each SHA in `pins.json` as a possible secret.
Run `uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record
the new SHAs as known values.
