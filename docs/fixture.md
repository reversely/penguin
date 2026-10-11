# Identity-unification fixture

The identity-unification fixture is a small Git repository that Penguin's integration runner tests
against. `examples/identity-unification/build.py` builds it from the source directories next to the
builder. Every build produces the same commit SHAs. `examples/identity-unification/pins.json` records
them.

## Branches and tags

| Ref | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: three scopes declared in `penguin/scopes.json` with their owners and agent identities |
| `owner-priya-checkpoint` (tag) | Priya | `person_id` with merge rules in `ingestion/identity_map.py`: a `login` event links its device to its user. A shared verified email links identities. A merged profile keeps the latest value of each attribute. |
| `owner-jun-checkpoint` (tag) | Jun | The retention dashboard in `analytics/retention.py` with `test_retention.py` and `test_identity.py` |
| `owner-sam-checkpoint` (tag) | Sam | The re-engagement email audience in `messaging/audience.py` with `test_audience.py` and `test_consent.py` |
| `owner-priya-limit-five` (tag) | Priya | On `owner-priya-checkpoint`: a login links a device to at most five user identities (`MAX_IDENTITIES_PER_DEVICE`) |
| `owner-priya` | Priya | On `owner-priya-limit-five`: the limit lowered to one, so each device links only its first user |
| `owner-jun` | Jun | On `owner-jun-checkpoint`: a cutover marker for past metrics in `analytics/retention.py` |
| `owner-sam` | Sam | On `owner-sam-checkpoint`: the audience leaves out a person when any identity linked to the person has unsubscribed |

Each checkpoint starts from `main`. Each fix commit starts from its owner's previous commit and changes
only paths in its owner's scope. Every scope's tests pass on each commit alone. `pins.json` records the
SHA of every branch head and tag. It also maps each failing test to the commit that fixes it.

## Expected failures

Merging Priya's checkpoint with Jun's or Sam's checkpoint fails three tests. All three belong to Jun's
and Sam's work. Case 1 names each test by module and test name without the `test_` prefix.

| PRD test ID | Pytest node ID | Merged tree | Failure |
|---|---|---|---|
| `test_retention::dau_stable` | `analytics/tests/test_retention.py::test_dau_stable` | `owner-priya-checkpoint` with `owner-jun-checkpoint` | A later login joins two of a past day's people into one. That day's daily active users drop from 2 to 1. |
| `test_identity::shared_device_split` | `analytics/tests/test_identity.py::test_shared_device_split` | `owner-priya-checkpoint` with `owner-jun-checkpoint` | Three patrons log in on one library tablet. The login rule joins them into one person. |
| `test_consent::unsubscribe_survives` | `messaging/tests/test_consent.py::test_unsubscribe_survives` | `owner-priya-checkpoint` with `owner-sam-checkpoint` | A person unsubscribes on mobile and later signs up on the web, where the form subscribes by default. The verified email merges the two profiles. The merged profile keeps the later subscribed value, so the address joins the campaign audience. |

## Fixes

The fixes follow case 1 in [the README](../README.md#use-cases). Merged with the other owner's
checkpoint, each fix makes its own test pass without help from another fix.

| Pytest node ID | Fix commit | Fix |
|---|---|---|
| `analytics/tests/test_retention.py::test_dau_stable` | `owner-jun` | The dashboard counts people by `person_id` from a cutover day on. The cutover is the first day on which the identity map, built from the events through that day, attributes an event to another identity. Days before the cutover count identities, so a later login leaves the past day's count at 2. |
| `analytics/tests/test_identity.py::test_shared_device_split` | `owner-priya` | A login links a device to at most one user identity. The tablet's later patrons stay separate people. |
| `messaging/tests/test_consent.py::test_unsubscribe_survives` | `owner-sam` | The audience reads each identity's latest consent event. A person with any unsubscribed identity is left out. |

`owner-priya-limit-five` is the commit that Jun's review answers in case 1: "a limit of five
still joins the tablet's users." Merged with `owner-jun`, it still fails `test_shared_device_split`,
because the tablet's three patrons are under the limit.

## Under the new procedure

In the approved design ([design.md](design.md#procedure)) this case runs as follows:

1. **Open.** Priya's agent opens "Add person_id with merge rules". Its area is the identity map with
   the `person_id` contract. No running feature works in that area, so the feature starts at once.
   Penguin lists the two running features that read the identity map: Jun's retention dashboard and
   Sam's re-engagement audience.
2. **Plan.** Penguin supplies the contract diff with the invariants of analytics and messaging.
   Priya's agent proposes two fixes. Jun's dashboard gets a cutover marker, so past days keep the
   counts they were published with. Sam's audience honours an unsubscribe from any identity linked
   to the person.
3. **Advance notice.** Sam's agent fills in the review form. The side-by-side run shows no consent
   changes once the fix is in, so Sam approves. Jun's agent reviews analytics' invariant "patrons who
   log in on one library tablet stay separate people". The side-by-side run shows strangers on one
   tablet merged into one person. The break sits in Priya's merge rules. Jun asks for a limit on
   identities per device in Priya's own feature. Priya's agent sets a limit of five
   (`owner-priya-limit-five`), which still merges a busy tablet's users. Jun asks for a lower limit.
   The second revision (`owner-priya`, a limit of one) passes.
4. **Build.** Priya's agent writes the cutover marker into Jun's existing fork. It writes the
   unsubscribe fix into Sam's. Today Jun and Sam make those fixes themselves (`owner-jun`,
   `owner-sam`).
5. **Block promotion.** The block passes every check against main and both forks. Penguin promotes it
   in one push. Jun is asked twice and Sam once.

Before it can run this way, the fixture needs three additions:

- `penguin/invariants.json` in the base commit, with the analytics invariant above and the
  messaging invariant on unsubscribes, in the format in [design.md](design.md#invariants-and-examples)
- contracts per scope in `penguin/scopes.json`, starting with the identity map's `person_id`
- Jun's and Sam's work as running features: forks of `main` in place of the `owner-*-checkpoint` tags

## Review harness on this fixture

`services/local-bridge/test/review-harness.test.ts` runs the review harness on a fresh build. The
test commits its own `penguin/invariants.json` to `main`: analytics declares "patrons who log in on
one library tablet stay separate people" as protected. It also declares the contracts
`analytics/models.py::daily_active_users` and `ingestion/identity_map.py::IdentityMap`. Its examples
file runs `daily_active_users` on two patrons on their own devices and on three patrons on one
tablet. Each argument builds its identity map with `IdentityMap.from_events`. Each fork is one of
Priya's commits merged onto that `main`.

| Fork | Input | Main | Fork |
|---|---|---|---|
| `owner-priya-checkpoint` | Three patrons on one library tablet | 3 people | 1 person |
| `owner-priya-checkpoint` | Two patrons on their own devices | 2 people | 2 people |
| `owner-priya-limit-five` | Six patrons on one tablet, a risky input | 6 people | 2 people |
| `owner-priya` | Six patrons on one tablet, a risky input | 6 people | 6 people |

On Priya's checkpoint a form claiming "holds" without evidence is refused with `no_evidence`. The
tablet difference still goes to Jun as a `protected_difference`. Citing Jun's
`analytics/tests/test_identity.py::test_shared_device_split` is refused with `evidence_not_found`,
because that test is only in Jun's fork. The contract diff shows `Profile` changing
shape, so the form needs a cutover marker.

## Manual reproduction

The steps need Git 2.38 or later for `git merge-tree --write-tree`. They also need Python 3 with
pytest. The test commands are the `test_command` values in `penguin/scopes.json`, run from the root of
the tree under test.

1. From the Penguin checkout, install the environment and put its Python first on `PATH`:

   ```sh
   uv sync
   export PATH="$PWD/.venv/bin:$PATH"
   ```

2. Build the fixture into a new directory and compare the refs with `pins.json`:

   ```sh
   python examples/identity-unification/build.py /tmp/penguin-fixture
   cat examples/identity-unification/pins.json
   ```

   The builder prints one line per branch and tag: the ref name and its commit SHA.

3. Check each commit alone. For each branch and tag other than `main`, extract the ref into its own
   directory and run the three scope test commands:

   ```sh
   cd /tmp/penguin-fixture
   mkdir ../owner-jun-checkpoint
   git archive owner-jun-checkpoint | tar -x -C ../owner-jun-checkpoint
   cd ../owner-jun-checkpoint
   python -m pytest ingestion
   python -m pytest analytics
   python -m pytest messaging
   cd /tmp/penguin-fixture
   ```

   Every command exits 0.

4. Merge Priya's checkpoint with Jun's checkpoint and run Jun's tests on the merged tree:

   ```sh
   git merge-tree --write-tree owner-priya-checkpoint owner-jun-checkpoint
   mkdir ../merged-jun
   git archive <tree SHA printed above> | tar -x -C ../merged-jun
   cd ../merged-jun
   python -m pytest analytics
   cd /tmp/penguin-fixture
   ```

   `git merge-tree` prints a single tree SHA because the merge has no conflicts. The test run
   reports `2 failed, 6 passed`. Its short test summary lists these two tests as `FAILED`:

   ```text
   analytics/tests/test_identity.py::test_shared_device_split
   analytics/tests/test_retention.py::test_dau_stable
   ```

5. Merge Priya's checkpoint with Sam's checkpoint and run Sam's tests on the merged tree:

   ```sh
   git merge-tree --write-tree owner-priya-checkpoint owner-sam-checkpoint
   mkdir ../merged-sam
   git archive <tree SHA printed above> | tar -x -C ../merged-sam
   cd ../merged-sam
   python -m pytest messaging
   cd /tmp/penguin-fixture
   ```

   The test run reports `1 failed, 10 passed`. Its short test summary lists this test as `FAILED`:

   ```text
   messaging/tests/test_consent.py::test_unsubscribe_survives
   ```

6. Merge the three fixed branches and run every scope's tests on the merged tree. `git merge-tree`
   merges two commits, so the first merged tree becomes a commit before the second merge:

   ```sh
   git merge-tree --write-tree owner-priya owner-jun
   git commit-tree <tree SHA printed above> -p owner-priya -p owner-jun -m "Merge owner-priya and owner-jun"
   git merge-tree --write-tree <commit SHA printed above> owner-sam
   mkdir ../combined
   git archive <tree SHA printed above> | tar -x -C ../combined
   cd ../combined
   python -m pytest ingestion
   python -m pytest analytics
   python -m pytest messaging
   ```

   Every command exits 0.

`uv run pytest -m slow` runs the same steps in `tests/test_fixture_reproduction.py`. It asserts that
every scope passes on each commit alone and that the merged checkpoints fail exactly the three tests
above. It asserts that each fix makes its own test pass, that `owner-priya-limit-five` still fails
`test_shared_device_split`, and that the combined run on the fixed branches passes. It also asserts
that `pins.json` maps each test to its fix commit and that each fix commit changes only its owner's
scope paths.

## Changing the fixture

A change to a source directory under `examples/identity-unification/` changes the SHA of the commit
built from it. It also changes the SHA of every commit that starts from that commit. Run `uv run pre-commit run --all-files` before
rebuilding, because ruff can rewrite a fixture source file. Then rebuild into an empty directory and
copy the printed SHAs into the `branches`, `tags` and `fixes` objects of `pins.json`. `tests/test_fixture_builder.py` fails until `pins.json`
matches a fresh build. The detect-secrets hook reads each SHA in `pins.json` as a possible secret.
Run `uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record
the new SHAs as known values.
