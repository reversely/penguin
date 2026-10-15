# Identity-unification fixture

The identity-unification fixture is a small Git repository that Penguin's integration runner tests
against. `examples/identity-unification/build.py` builds it from the source directories next to the
builder. `examples/identity-unification/features.json` lists the base commit and each feature: its
id, owner, role, fork branch, declared area and commits. Every build produces the same commit SHAs.
`examples/identity-unification/pins.json` records them.

## Branches and tags

| Ref | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: three scopes in two teams, declared in `penguin/teams.json` and `penguin/scopes.json` with their DRIs and contracts. `penguin/identities.json` holds a steward per person and a builder per feature. `penguin/invariants.json` declares the analytics and messaging invariants with their recorded examples |
| `owner-priya-checkpoint` (tag) | Priya | `person_id` with merge rules in `ingestion/identity_map.py`: a `login` event links its device to its user. A shared verified email links identities. A merged profile keeps the latest value of each attribute. |
| `owner-jun-checkpoint` (tag) | Jun | The retention dashboard in `analytics/retention.py` with `test_retention.py` and `test_identity.py`. `penguin/scopes.json` adds the contract `analytics/retention.py::retention_dashboard` |
| `owner-sam-checkpoint` (tag) | Sam | The re-engagement email audience in `messaging/audience.py` with `test_audience.py` and `test_consent.py`. `penguin/scopes.json` adds the contract `messaging/audience.py::reengagement_audience`. `penguin/invariants.json` adds its examples file `messaging/examples/reengagement_audience.json` |
| `owner-priya-fix-analytics` (tag) | Priya | On `owner-priya-checkpoint`: the fix for analytics' code on main. `daily_active_users` in `analytics/models.py` counts people by `person_id` from a cutover day on, with `test_published_day_keeps_its_count_after_a_later_login` |
| `owner-priya-fix-messaging` (tag) | Priya | On `owner-priya-fix-analytics`: the fix for messaging's code on main. `is_subscribed` in `messaging/subscriptions.py` leaves out a person when any linked identity's latest consent is an unsubscribe, with `test_unsubscribe_on_a_linked_identity_holds_after_a_signup` |
| `owner-priya-limit-five` (tag) | Priya | On `owner-priya-fix-messaging`: a login links a device to at most five user identities (`MAX_IDENTITIES_PER_DEVICE`) |
| `owner-priya` | Priya | On `owner-priya-limit-five`: the limit lowered to one, so each device links only its first user |
| `owner-jun` | Jun | On `owner-jun-checkpoint`: a cutover marker for past metrics in `analytics/retention.py` |
| `owner-sam` | Sam | On `owner-sam-checkpoint`: the audience leaves out a person when any identity linked to the person has unsubscribed |

Each feature is a fork of `main`: its first commit starts from `main` and each later commit from the
fork's previous commit. Each fix commit for a feature changes only paths in its owner's scope. Each
of Priya's fixes for code on main changes only the scope it fixes. `features.json` marks such a
commit with `fix` and the scope's id. It marks the limit of five and the limit of one with `revises`
and `analytics`: each answers one change Jun asks for on the plan's part for analytics' code on
main. The walkthrough has Jun ask once per such commit ([walkthrough.md](walkthrough.md)). A running
feature's checkpoint also declares its new contract in its own scope's entry of the penguin files.
Every scope's tests pass on each commit alone. `pins.json` records the SHA of every branch head and
tag. It also maps each failing test to the commit that fixes it.

## Expected failures

Merging Priya's checkpoint with Jun's or Sam's checkpoint fails three tests. All three belong to Jun's
and Sam's work. Case 1 names each test by module and test name without the `test_` prefix.

| PRD test ID | Pytest node ID | Merged tree | Failure |
|---|---|---|---|
| `test_retention::dau_stable` | `analytics/tests/test_retention.py::test_dau_stable` | `owner-priya-checkpoint` with `owner-jun-checkpoint` | A later login joins two of a past day's people into one. That day's daily active users drop from 2 to 1. |
| `test_identity::shared_device_split` | `analytics/tests/test_identity.py::test_shared_device_split` | `owner-priya-checkpoint` with `owner-jun-checkpoint` | Three patrons log in on one library tablet. The login rule joins them into one person. |
| `test_consent::unsubscribe_survives` | `messaging/tests/test_consent.py::test_unsubscribe_survives` | `owner-priya-checkpoint` with `owner-sam-checkpoint` | A person unsubscribes on mobile and later signs up on the web, where the form subscribes by default. The verified email merges the two profiles. The merged profile keeps the later subscribed value, so the address joins the campaign audience. |

## Fixes

The fixes follow case 1 in [the walkthrough](walkthrough.md). Merged with the other owner's
checkpoint, each fix makes its own test pass without help from another fix.

| Pytest node ID | Fix commit | Fix |
|---|---|---|
| `analytics/tests/test_retention.py::test_dau_stable` | `owner-jun` | The dashboard counts people by `person_id` from a cutover day on. The cutover is the first day on which the identity map, built from the events through that day, attributes an event to another identity. Days before the cutover count identities, so a later login leaves the past day's count at 2. |
| `analytics/tests/test_identity.py::test_shared_device_split` | `owner-priya` | A login links a device to at most one user identity. The tablet's later patrons stay separate people. |
| `messaging/tests/test_consent.py::test_unsubscribe_survives` | `owner-sam` | The audience reads each identity's latest consent event. A person with any unsubscribed identity is left out. |

### Fixes for code on main

Main's own analytics and messaging code reads the identity map, so Priya's merge rules change what
it returns. On `owner-priya-checkpoint`, `daily_active_users` on `main` drops a published day's count
when a later login links two of that day's identities. `subscription_status` on `main` reports a
person subscribed after an unsubscribe on mobile and a later web signup. Each break goes against an
invariant of the scope on `main`, so the merge plan needs a part for each scope's code on main. The
part names Priya's fix commit for that scope:

| Scope | Fix commit | Fix | Test the fix adds |
|---|---|---|---|
| analytics | `owner-priya-fix-analytics` | `daily_active_users` counts identities before the cutover day and people from it on, the rule Jun's retention dashboard follows | `analytics/tests/test_dau.py::test_published_day_keeps_its_count_after_a_later_login` |
| messaging | `owner-priya-fix-messaging` | `is_subscribed` reads each linked identity's latest consent, so the CRM rows and the subscription status leave out a person with an unsubscribed identity | `messaging/tests/test_subscriptions.py::test_unsubscribe_on_a_linked_identity_holds_after_a_signup` |

Each added test states its scope's invariant in its docstring. It fails on `owner-priya-checkpoint`
and passes on its fix commit.

### The limit of five

`owner-priya-limit-five` is the commit that Jun's review answers in case 1: "a limit of five
still joins the tablet's users." Merged with `owner-jun`, it still fails `test_shared_device_split`,
because the tablet's three patrons are under the limit.

## Walkthrough run

The walkthrough runs this fixture as case 1 ([walkthrough.md](walkthrough.md#what-each-case-runs)).
It reads every person, commit and review form from the fixture (`tests/walkthrough/support/fixture.ts`):

1. **Open.** Jun's and Sam's agents open their features and publish `owner-jun-checkpoint` and
   `owner-sam-checkpoint`. Priya's agent opens "Add person_id with merge rules" with its
   `features.json` area and publishes `owner-priya-checkpoint`.
2. **Plan.** Priya's agent pushes `owner-priya-fix-analytics` and `owner-priya-fix-messaging` and
   proposes one part per affected place: those commits for analytics' and messaging's code on main,
   and Jun's and Sam's fixes (`owner-jun`, `owner-sam`) as patches against their fork heads.
3. **Advance notice.** Jun's and Sam's agents submit `reviews/analytics.json` and
   `reviews/messaging.json`. Jun asks for one change on the analytics part per commit marked
   `revises`. Priya's agent answers the first request with the limit of five and the second with
   the limit of one.
4. **Build.** The check runner writes each approved part into Jun's and Sam's forks. The walkthrough
   checks that each written tree equals the fixture's fix tree.
5. **Land.** Priya's agent lands the feature. The walkthrough then runs every scope's tests on main's
   new head.

## Invariants, contracts and features

The base commit's `penguin/invariants.json` holds three invariants in Penguin's invariants format
(`packages/scope-map/src/invariants.ts`). Their wording follows the tests that check them.

| Id | Scope | Statement | Protected | Recorded examples |
|---|---|---|---|---|
| `tablet-patrons-separate` | analytics | Patrons who log in on one library tablet stay separate people | yes | `analytics/examples/tablet_patrons.json`: two patrons on their own devices, three patrons on one library tablet, six patrons on one library tablet |
| `published-day-counts-stable` | analytics | A published day's daily active users stay the same when later days' events arrive | no | `analytics/examples/published_days.json`: a new visitor on a later day, a later login that links two identities active on a published day |
| `unsubscribe-holds` | messaging | An unsubscribe on any linked identity holds after a later signup subscribes the address by default | no | `messaging/examples/subscription_status.json` on `main`. Sam's fork adds `messaging/examples/reengagement_audience.json` |

Each examples file runs `daily_active_users`, `subscription_status` or `reengagement_audience`. Each
case builds its identity map with `IdentityMap.from_events` from the case's own events.
`penguin/scopes.json` declares each scope's contracts. The identity map declares `Event`,
`IdentityMap`, `Profile` and `profile_key`. Analytics declares `daily_active_users`. Messaging
declares `crm_rows`, `is_subscribed` and `subscription_status`.

`features.json` lists Priya's feature "Add person_id with merge rules" as the originating feature on
the fork `owner-priya`. Jun's retention dashboard (`owner-jun`) and Sam's re-engagement audience
(`owner-sam`) are the running features. A feature's `area` is the declaration its agent sends when
the feature opens. Penguin checks its contracts against `penguin/scopes.json` on `main`, so a running
feature's area names no contract. Each running feature declares its new contract in its own scope's
entry of `penguin/scopes.json` on its fork. The two forks change separate entries, so they merge
without a conflict.

`reviews/analytics.json` and `reviews/messaging.json` hold the review forms Jun's and Sam's agents
submit on Priya's feature. Jun's form reports `tablet-patrons-separate` as broken. Sam's form reports
`unsubscribe-holds` as holding. Each row's evidence is the contract the invariant's recorded examples
run. Jun's form also names the cutover marker `analytics/retention.py::person_id_cutover`, which only
Jun's fork holds: Jun's fix adds a `cutover` field to the stored `RetentionDashboard`, which
analytics owns. Sam's form names no marker, since Sam's fork holds none and messaging only reads
the `Profile` store that identity-map owns. Priya's commits hold no migration or backfill for
`Profile`, so the plan the preview proposes from this fixture declares no `storeMarker`. The
builder does not commit the forms.

## Impact and review on this fixture

The results below come from `penguin-bridge impact`, `penguin-bridge review` and
`penguin-bridge check` on a fresh build. A review's fork is one of Priya's commits or a block tree: a
running fork's head with Priya's head merged onto it.

`penguin-bridge impact --base main --head owner-priya-checkpoint`, with Jun's and Sam's checkpoints
as forks, reports changes to the contracts `IdentityMap` and `Profile`. It reports a breaking
signature change of `Profile.set` and a stored shape change of the `Profile` dataclass. Both forks
use the changed symbols, so both forks run tests.

| Review | Base | Fork | Side-by-side differences | Verdict and exceptions |
|---|---|---|---|---|
| Analytics | `main` | `owner-priya-checkpoint` | Three patrons on one tablet: 3 people on main, 1 on the fork. Six patrons: 6 and 1. A later login on a published day: that day's count drops from 2 to 1 | Refused with `evidence_not_found`: the marker the form names is in Jun's fork only. Analytics reads no changed stored shape, so the stored data rule asks nothing. The tablet difference goes to Jun as a `protected_difference` |
| Analytics | `main` | `owner-priya-limit-five` | Three patrons: 3 and 1. Six patrons: 6 and 2. The published-day example matches main, because `owner-priya-fix-analytics` comes before the limit | Refused with `evidence_not_found`, as above. A `protected_difference` goes to Jun |
| Analytics | `main` | `owner-priya` merged onto `owner-jun` | No example differs on `daily_active_users`. The tablet examples and the published-day example match main | Accepted, with the cutover marker in the tree. The row Jun's form reports broken goes to Jun as a `broken_invariant` |
| Messaging, without the contract diff | `owner-sam-checkpoint` | `owner-priya-checkpoint` merged onto it | After an unsubscribe on mobile and a web signup, `subscription_status` gives `device:d1` false and `user:u1` true on the base. The fork gives one subscribed person. `reengagement_audience` returns no address on the base and `a@example.com` on the fork | Accepted. No exception: Sam's form reports `unsubscribe-holds` holding. The invariant is not protected |
| Messaging, without the contract diff | `owner-sam` | `owner-priya` merged onto it | `reengagement_audience` matches on both examples. `subscription_status` gives `device:d1` false and `user:u1` true on the base. The fork gives one person, `device:d1`, not subscribed, through `owner-priya-fix-messaging` | Accepted. No exception |

The messaging reviews run with `--no-diff`. With the contract diff, the review of Sam's checkpoint is
still accepted: it records `Profile` as a changed stored shape that messaging reads from
identity-map, which the owning change covers, so Sam's form needs no marker. Analytics reads no
changed stored shape, so it needs no marker for `Profile` either.

`penguin-bridge check` on the three checkpoints passes overlap, merge, dependencies, lint, format and
the type check on every merged tree. It fails `test_shared_device_split` and `test_dau_stable` on
Jun's merged tree. It fails `test_unsubscribe_survives` on Sam's. On the three fixed heads every
check passes.

## Teams

`penguin/teams.json` on `main` declares two teams:

```json
{
  "teams": [
    { "id": "data", "name": "Data", "lead": "priya", "members": ["priya", "jun"] },
    { "id": "lifecycle", "name": "Lifecycle messaging", "lead": "sam", "members": ["sam"] }
  ]
}
```

| Field | Holds |
|---|---|
| `id` | Lowercase letters, digits and hyphens, at most 64 characters, unique in the file |
| `name` | The team's name, at most 128 characters |
| `lead` | A person id from `penguin/owners.json`, usually the engineering manager. The lead need not be a member |
| `members` | One to 256 person ids, each once |

Each scope in `penguin/scopes.json` names `team`, `dri` and an optional `fallback` in place of
`owner`:

| Scope | Team | DRI | Fallback | Reads |
|---|---|---|---|---|
| `identity-map` | `data` | Priya | Jun | none |
| `analytics` | `data` | Jun | Priya | `identity-map` |
| `messaging` | `lifecycle` | Sam | none | `identity-map` |

The fixture's code holds three modules, so each person is DRI for one scope here. Jun and Priya
stand in for each other. Sam has no teammate to stand in, so a decision on messaging waits for Sam.

The DRI and every fallback must be members of the team. The fallback order names no one twice and
leaves out the DRI. A scope names either `owner` or `team` and `dri`. A scope that names only an
`owner` reads as that owner's one-person team, `person:<owner>`. Penguin refuses the whole scope
file when any of these rules fails. `tests/fixtures/team-scopes/penguin/` holds a two-person team with
a DRI and a fallback, a lead outside the team and one scope that still names an owner.

`penguin/identities.json` gives each person one steward, `@<person>/steward`, chartered on every
scope the person is DRI for. Each feature has one builder, `@<person>/<feature>`, chartered on the
scopes of its area the person is DRI for: `@priya/person-id-merge-rules`, `@jun/retention-dashboard`
and `@sam/reengagement-audience`. The walkthrough and the preview register each feature's agent
session as its builder.

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

`tests/test_fixtures.py` checks the fixture's files. Under `uv run pytest -m slow` it asserts that a
fresh build reproduces every branch and tag in `pins.json`. The fast run asserts that each scope's
DRI and fallback are members of its team and that each identity's charter names only scopes its
owner is DRI for. No automated test runs the manual steps above.

## Changing the fixture

A change to a source directory under `examples/identity-unification/` changes the SHA of the commit
built from it. It also changes the SHA of every commit that starts from that commit. Run
`uv run pre-commit run --all-files` before rebuilding, because ruff can rewrite a fixture source
file. Then rebuild into an empty directory and copy the printed SHAs into the `branches`, `tags` and
`fixes` objects of `pins.json`. A new commit goes into `features.json`. `examples/ruff.toml` makes
ruff in this repository sort the fixture's imports as ruff does in the built repository.
`tests/test_fixtures.py` fails until `pins.json` matches a fresh build. The detect-secrets hook
reads each SHA in `pins.json` as a possible secret. Run
`uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record the
new SHAs as known values.
