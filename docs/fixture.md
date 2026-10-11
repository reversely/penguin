# Identity-unification fixture

The identity-unification fixture is a small Git repository that Penguin's integration runner tests
against. `examples/identity-unification/build.py` builds it from the source directories next to the
builder. Every build produces the same commit SHAs. `examples/identity-unification/pins.json` records
them.

## Branches

| Branch | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: three scopes declared in `penguin/scopes.json` with their owners and agent identities |
| `owner-priya` | Priya | `person_id` with merge rules in `ingestion/identity_map.py`: a `login` event links its device to its user. A shared verified email links identities. A merged profile keeps the latest value of each attribute. |
| `owner-jun` | Jun | The retention dashboard in `analytics/retention.py` with `test_retention.py` and `test_identity.py` |
| `owner-sam` | Sam | The re-engagement email audience in `messaging/audience.py` with `test_audience.py` and `test_consent.py` |

Each checkpoint branch starts from `main`. Every scope's tests pass on each branch alone.

## Expected failures

Merging Priya's checkpoint with Jun's or Sam's checkpoint fails three tests. All three belong to Jun's
and Sam's work. The PRD names each test by module and test name without the `test_` prefix.

| PRD test ID | Pytest node ID | Merged tree | Failure |
|---|---|---|---|
| `test_retention::dau_stable` | `analytics/tests/test_retention.py::test_dau_stable` | `owner-priya` with `owner-jun` | A later login joins two of a past day's people into one. That day's daily active users drop from 2 to 1. |
| `test_identity::shared_device_split` | `analytics/tests/test_identity.py::test_shared_device_split` | `owner-priya` with `owner-jun` | Three patrons log in on one library tablet. The login rule joins them into one person. |
| `test_consent::unsubscribe_survives` | `messaging/tests/test_consent.py::test_unsubscribe_survives` | `owner-priya` with `owner-sam` | A person unsubscribes on mobile and later signs up on the web, where the form subscribes by default. The verified email merges the two profiles. The merged profile keeps the later subscribed value, so the address joins the campaign audience. |

## Manual reproduction

The steps need Git 2.38 or later for `git merge-tree --write-tree`. They also need Python 3 with
pytest. The test commands are the `test_command` values in `penguin/scopes.json`, run from the root of
the tree under test.

1. From the Penguin checkout, install the environment and put its Python first on `PATH`:

   ```sh
   uv sync
   export PATH="$PWD/.venv/bin:$PATH"
   ```

2. Build the fixture into a new directory and compare the branch heads with `pins.json`:

   ```sh
   python examples/identity-unification/build.py /tmp/penguin-fixture
   cat examples/identity-unification/pins.json
   ```

   The builder prints one line per branch: the branch name and its head SHA.

3. Check each checkpoint branch alone. For each of `owner-priya`, `owner-jun` and `owner-sam`, extract
   the branch into its own directory and run the three scope test commands:

   ```sh
   cd /tmp/penguin-fixture
   mkdir ../owner-jun
   git archive owner-jun | tar -x -C ../owner-jun
   cd ../owner-jun
   python -m pytest ingestion
   python -m pytest analytics
   python -m pytest messaging
   cd /tmp/penguin-fixture
   ```

   Every command exits 0.

4. Merge Priya's checkpoint with Jun's checkpoint and run Jun's tests on the merged tree:

   ```sh
   git merge-tree --write-tree owner-priya owner-jun
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
   git merge-tree --write-tree owner-priya owner-sam
   mkdir ../merged-sam
   git archive <tree SHA printed above> | tar -x -C ../merged-sam
   cd ../merged-sam
   python -m pytest messaging
   ```

   The test run reports `1 failed, 10 passed`. Its short test summary lists this test as `FAILED`:

   ```text
   messaging/tests/test_consent.py::test_unsubscribe_survives
   ```

`uv run pytest -m slow` runs the same steps in `tests/test_fixture_reproduction.py`. It asserts that
every scope passes on each checkpoint branch. It also asserts that the two merged trees fail exactly
the three tests above.

## Changing the fixture

A change to a source directory under `examples/identity-unification/` changes the SHA of the commit
built from it. It also changes the SHA of every commit that starts from that commit. Run `uv run pre-commit run --all-files` before
rebuilding, because ruff can rewrite a fixture source file. Then rebuild into an empty directory and
copy the printed SHAs into `pins.json`. `tests/test_fixture_builder.py` fails until `pins.json`
matches a fresh build. The detect-secrets hook reads each SHA in `pins.json` as a possible secret.
Run `uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record
the new SHAs as known values.
